import { createApp } from 'vue';
import { createRouter, createWebHistory } from 'vue-router';
import App from './App.vue';
import './style.css';
const router = createRouter({ history: createWebHistory('/admin/'), routes: [{ path: '/:pathMatch(.*)*', component: { render: () => null } }] });
createApp(App).use(router).mount('#app');
