/*
 * majin-setup — the double-click installer stub.
 *
 * It does exactly four things: write the payload that was compiled into it,
 * unpack it with the `tar` that ships in Windows 10/11, hand over to
 * setup.ps1, and report. No registry, no admin, no download of itself, and no
 * Windows API calls at all -- which is what makes the same file compilable and
 * runnable for testing on any other system (set MAJIN_SETUP_CMD to a script and
 * it will extract there instead).
 *
 * Everything the installer actually decides lives in setup/setup.ps1, where it
 * is readable before you run it. `--print` shows the two commands without
 * touching the disk.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "payload.h" /* MAJIN_VERSION, MAJIN_PAYLOAD_LEN, MAJIN_PAYLOAD_SHA256, MAJIN_PAYLOAD */

#ifdef _WIN32
#include <direct.h>
#define MKDIR_ONE(p) _mkdir(p)
#else
#include <sys/stat.h>
#define MKDIR_ONE(p) mkdir((p), 0755)
#endif

#define PATH_MAX_LOCAL 4096

static void mkdirp(const char *path) {
  char buf[PATH_MAX_LOCAL];
  size_t n = strlen(path);
  if (n == 0 || n >= sizeof(buf)) return;
  memcpy(buf, path, n + 1);
  for (size_t i = 1; i < n; i++) {
    if (buf[i] == '/' || buf[i] == '\\') {
      char save = buf[i];
      buf[i] = '\0';
      MKDIR_ONE(buf);
      buf[i] = save;
    }
  }
  MKDIR_ONE(buf);
}

static void default_dir(char *out, size_t cap) {
  const char *appdata = getenv("LOCALAPPDATA");
  if (appdata && *appdata) {
    snprintf(out, cap, "%s%sMAJIN", appdata, strchr(appdata, '/') ? "/" : "\\");
    return;
  }
  const char *home = getenv("HOME");
  if (!home || !*home) home = getenv("USERPROFILE");
  snprintf(out, cap, "%s/.majin", (home && *home) ? home : ".");
}

static void usage(void) {
  printf("majin-setup %s -- installs MAJIN without git, admin or an installer\n\n"
         "  --dir <path>    install under this folder (default: %%LOCALAPPDATA%%\\MAJIN)\n"
         "  --print         show what would run, change nothing\n"
         "  --keep          leave payload.tar.gz next to the app (for inspection)\n"
         "  --version       print the version, the payload size and its sha256\n"
         "  --help          this text\n\n"
         "After installing:  majin start   (or the MAJIN icon on the Desktop)\n",
         MAJIN_VERSION);
}

int main(int argc, char **argv) {
  char dir[PATH_MAX_LOCAL] = "";
  char payload[PATH_MAX_LOCAL];
  char script[PATH_MAX_LOCAL];
  char tar_cmd[PATH_MAX_LOCAL * 2 + 64];
  char run_cmd[PATH_MAX_LOCAL * 2 + 256];
  int keep = 0, print_only = 0;
  const char *env_dir = getenv("MAJIN_SETUP_DIR");
  const char *handover = getenv("MAJIN_SETUP_CMD");

  for (int i = 1; i < argc; i++) {
    if (!strcmp(argv[i], "--keep")) keep = 1;
    else if (!strcmp(argv[i], "--print")) print_only = 1;
    else if (!strcmp(argv[i], "--help") || !strcmp(argv[i], "-h")) { usage(); return 0; }
    else if (!strcmp(argv[i], "--version") || !strcmp(argv[i], "-v")) {
      printf("majin-setup %s · payload %lu B · sha256 %s\n", MAJIN_VERSION,
             (unsigned long)MAJIN_PAYLOAD_LEN, MAJIN_PAYLOAD_SHA256);
      return 0;
    } else if (!strcmp(argv[i], "--dir") && i + 1 < argc) {
      snprintf(dir, sizeof(dir), "%s", argv[++i]);
    } else {
      fprintf(stderr, "majin-setup: unknown argument \"%s\" (try --help)\n", argv[i]);
      return 2;
    }
  }

  if (!dir[0] && env_dir && *env_dir) snprintf(dir, sizeof(dir), "%s", env_dir);
  if (!dir[0]) default_dir(dir, sizeof(dir));
  snprintf(payload, sizeof(payload), "%s%cpayload.tar.gz", dir,
           strchr(dir, '/') ? '/' : '\\');
  snprintf(script, sizeof(script), "%s%csetup.ps1", dir, strchr(dir, '/') ? '/' : '\\');

  if (print_only) {
    printf("write   %s (%lu B, sha256 %s)\n", payload, (unsigned long)MAJIN_PAYLOAD_LEN,
           MAJIN_PAYLOAD_SHA256);
    printf("unpack  tar -xf \"%s\" -C \"%s\"\n", payload, dir);
    printf("install %s\n", handover && *handover ? handover
                                                 : "\"powershell\" -NoProfile -ExecutionPolicy Bypass -File setup.ps1");
    return 0;
  }

  mkdirp(dir);
  FILE *f = fopen(payload, "wb");
  if (!f) {
    fprintf(stderr, "majin-setup: cannot write %s -- try --dir <a folder you own>\n", payload);
    return 1;
  }
  size_t left = MAJIN_PAYLOAD_LEN, done = 0;
  while (left > done) {
    size_t w = fwrite(MAJIN_PAYLOAD + done, 1, left - done, f);
    if (w == 0) {
      fprintf(stderr, "majin-setup: short write to %s (%lu of %lu bytes)\n", payload,
              (unsigned long)done, (unsigned long)MAJIN_PAYLOAD_LEN);
      fclose(f);
      return 1;
    }
    done += w;
  }
  fclose(f);

  snprintf(tar_cmd, sizeof(tar_cmd), "tar -xf \"%s\" -C \"%s\"", payload, dir);
  int rc = system(tar_cmd);
  if (rc != 0) {
    fprintf(stderr,
            "majin-setup: tar failed (%d). Windows 10/11 ship tar.exe in System32;\n"
            "  if it was removed, unpack \"%s\" by hand and run setup.ps1 there.\n",
            rc, payload);
    return 1;
  }
  if (!keep) remove(payload);

  if (handover && *handover) {
    snprintf(run_cmd, sizeof(run_cmd), "%s \"%s\"", handover, script);
  } else {
    snprintf(run_cmd, sizeof(run_cmd),
             "\"powershell\" -NoProfile -ExecutionPolicy Bypass -File \"%s\" -Target \"%s\"", script, dir);
  }
  printf("install %s\n", run_cmd);
  rc = system(run_cmd);
  if (rc != 0) {
    fprintf(stderr,
            "majin-setup: setup.ps1 exited with %d -- the files are in %s, and it can be\n"
            "  re-run there: powershell -NoProfile -ExecutionPolicy Bypass -File setup.ps1\n",
            rc, dir);
    return 1;
  }
  printf("done    majin %s in %s\n", MAJIN_VERSION, dir);
  return 0;
}
