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

app.mount('#app');
