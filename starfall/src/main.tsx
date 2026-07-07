import { createRoot } from 'react-dom/client';
import App from './ui/App';
import { startGameLoop } from './store';
import './styles.css';

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(<App />);
  startGameLoop();
}
