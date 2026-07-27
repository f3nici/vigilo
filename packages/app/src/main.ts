import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import { router } from './router';
import { useThemeStore } from './stores/theme';
import './styles/main.css';

const app = createApp(App);
app.use(createPinia());
app.use(router);

const theme = useThemeStore();
theme.apply();
theme.watchSystem();

// The router guard loads the session before the first navigation resolves, so
// a reload lands on the right screen rather than bouncing through sign-in.
app.mount('#app');
