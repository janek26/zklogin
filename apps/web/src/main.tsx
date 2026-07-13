import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { GoogleOAuthProvider } from '@react-oauth/google'
import { App } from './App'
import { config } from './config'
import './style.css'
createRoot(document.getElementById('root')!).render(<StrictMode><GoogleOAuthProvider clientId={config.googleClientId}><App /></GoogleOAuthProvider></StrictMode>)
