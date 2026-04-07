import { contextBridge } from 'electron';

contextBridge.exposeInMainWorld('currentDesktop', {
  platform: process.platform,
});
