import { StrictMode, forwardRef } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Link as RouterLink } from 'react-router-dom';
import { Theme } from '@astryxdesign/core/theme';
import { LinkProvider } from '@astryxdesign/core/Link';
import { ToastViewport } from '@astryxdesign/core/Toast';
import { neutralTheme } from '@astryxdesign/theme-neutral/built';
import './styles.css';
import App from './App.jsx';

// Astryx links render `href`; route internal ones through react-router.
const AppLink = forwardRef(function AppLink({ href = '', ...props }, ref) {
  if (/^(https?:|mailto:|#|\/api\/)/.test(href)) return <a ref={ref} href={href} {...props} />;
  return <RouterLink ref={ref} to={href} {...props} />;
});

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <BrowserRouter>
      <Theme theme={neutralTheme} mode="system">
        <LinkProvider component={AppLink}>
          <ToastViewport position="bottomEnd">
            <App />
          </ToastViewport>
        </LinkProvider>
      </Theme>
    </BrowserRouter>
  </StrictMode>,
);
