const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getLiveRooms: (advId: string) => ipcRenderer.invoke('get-live-rooms', advId),
  getAccounts: () => ipcRenderer.invoke('get-accounts'),
  addAccount: (advId: string, name?: string) => ipcRenderer.invoke('add-account', advId, name),
  removeAccount: (advId: string) => ipcRenderer.invoke('remove-account', advId),
  getAvailableAccounts: () => ipcRenderer.invoke('get-available-accounts'),
  batchAddAccounts: (accounts: { advId: string; name?: string }[]) => ipcRenderer.invoke('batch-add-accounts', accounts),
  getAuthStatus: () => ipcRenderer.invoke('get-auth-status'),
  triggerAgentAuth: () => ipcRenderer.invoke('agent-auth'),
  getAgentStatus: () => ipcRenderer.invoke('agent-status'),
  cancelAgentAuth: () => ipcRenderer.invoke('agent-auth-cancel'),
  refreshAccount: (advId: string) => ipcRenderer.invoke('refresh-account', advId),
  getRoomFunnel: (advId: string, roomId: string, anchorId: string) => ipcRenderer.invoke('get-room-funnel', advId, roomId, anchorId),
  openLiveBoard: (advId: string, roomId: string, awemeId: string) => ipcRenderer.invoke('open-live-board', advId, roomId, awemeId),
  getVersion: () => ipcRenderer.invoke('get-version'),
  checkUpdate: () => ipcRenderer.invoke('check-update'),
  doUpdate: () => ipcRenderer.invoke('do-update'),
  onDataUpdate: (callback: () => void) => {
    ipcRenderer.on('data-update', callback);
    return () => ipcRenderer.removeListener('data-update', callback);
  },
  onUpdateProgress: (callback: (percent: number) => void) => {
    const handler = (_event: any, percent: number) => callback(percent);
    ipcRenderer.on('update-progress', handler);
    return () => ipcRenderer.removeListener('update-progress', handler);
  },
});
