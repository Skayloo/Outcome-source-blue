'use strict';

// The bridge for picker.html. It gets a list and two verbs, nothing else: the chooser renders
// thumbnails of every window on the machine, so it runs with no Node and no access to anything
// beyond naming which source the user picked.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('picker', {
  // System sound is captured by loopback, which only Windows implements. Elsewhere the
  // checkbox has to say so rather than quietly handing over a silent track.
  audioSupported: process.platform === 'win32',
  sources: () => ipcRenderer.invoke('picker:sources'),
  choose: (id, audio) => ipcRenderer.send('picker:choose', { id, audio: !!audio }),
  cancel: () => ipcRenderer.send('picker:cancel'),
});
