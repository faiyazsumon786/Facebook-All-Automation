(() => {
  if (!window.fsApp?.integratedTitleBar) return;
  const controls = document.getElementById('window-controls');
  const maximize = document.getElementById('window-maximize');
  const update = state => {
    controls.classList.toggle('maximized', !!state?.maximized);
    maximize.title = state?.maximized ? 'Restore down' : 'Maximize';
    maximize.setAttribute('aria-label', maximize.title);
  };
  window.fsApp.onWindowState(update);
  window.fsApp.windowControl('state').then(update);
  for (const action of ['minimize', 'maximize', 'close']) {
    document.getElementById('window-' + action).onclick = () => window.fsApp.windowControl(action).then(update);
  }
})();
