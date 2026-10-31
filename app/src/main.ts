// Browser entry point: mounts the app into #app (index.html).
import { renderApp } from './app';

const root = document.querySelector<HTMLElement>('#app');
if (root) renderApp(root);
