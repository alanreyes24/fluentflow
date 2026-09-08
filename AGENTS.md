# Instructions for coding agents

## Keep the macOS desktop app running against the repo

After making any code change, ensure both development processes are running so
the local macOS Electron app reflects the current working tree:

```bash
npm run dev
npm run desktop:dev
```

These commands are long-running and should be started in separate terminals or
background sessions. If either process is already running, do not start a
duplicate; verify that it is healthy instead. `npm run dev` provides the Expo
web server and local API, while `npm run desktop:dev` launches Electron against
the web server with Fast Refresh. Restart the Electron process if a change to
the main process, preload, or other Electron-only code is not picked up by
Fast Refresh.
