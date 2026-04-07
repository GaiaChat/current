import { app, BrowserWindow, shell } from 'electron';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

function createWindow() {
  const window = new BrowserWindow({
    width: 1500,
    height: 920,
    minWidth: 1100,
    minHeight: 680,
    title: 'Current',
    backgroundColor: '#0a111b',
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const devUrl = process.env.CURRENT_WEB_URL ?? 'http://127.0.0.1:5173';

  if (process.env.CURRENT_DEV === '1') {
    void window.loadURL(devUrl);
    window.webContents.openDevTools({ mode: 'detach' });
  } else {
    const webDistPath = join(__dirname, '../../web/dist/index.html');
    void window.loadURL(pathToFileURL(webDistPath).toString());
  }

  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
