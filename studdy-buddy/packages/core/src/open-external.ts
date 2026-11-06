import { spawn } from 'node:child_process';

/** Open a URL/file with the OS handler without interpolating a shell command. */
export function openExternal(target: string, platform: string = process.platform): Promise<void> {
  const command = platform === 'win32' ? 'rundll32.exe' : platform === 'darwin' ? 'open' : 'xdg-open';
  const args = platform === 'win32' ? ['url.dll,FileProtocolHandler', target] : [target];
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { shell: false, windowsHide: true, stdio: 'ignore' });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`OS opener exit ${code}`)));
  });
}
