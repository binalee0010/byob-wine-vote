import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';

function Startup() {
  React.useLayoutEffect(() => {
    window.dispatchEvent(new Event('byob:mounted'));
    document.getElementById('startup-fallback')?.remove();
  }, []);
  return <App />;
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><Startup /></React.StrictMode>);
