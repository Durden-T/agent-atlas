import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import './styles.css';
const element = document.getElementById('root');
if (!element) throw new Error('缺少应用根节点');
createRoot(element).render(<App />);
