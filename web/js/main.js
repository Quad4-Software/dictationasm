import { bootApp } from './ui/app.js';
import { registerPWA } from './pwa.js';

await registerPWA();
await bootApp();
