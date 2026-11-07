# MAJIN v1.0.9

This release includes merged PRs #231–#235: inline chat controls, persistent live previews, improved hands-free voice status and error recovery, transparent task progress, clickable links, updater visibility/relaunch fixes, and browser tab reuse.

The v1.0.9 source version is synchronized across runtime, npm metadata, installer and publishing scripts.

**Release acceptance:** publish Windows installer and portable executable from the `main` commit through `.github/workflows/build-exe.yml`; verify the downloaded release binaries against generated SHA256 manifests. An updated source tree alone is not a published app update.

Voice uses browser speech recognition/synthesis and is *not* proven equivalent to a low-latency streaming full-duplex speech model. Audibility and interruption on the user's exact Windows audio device require a real-device test.
