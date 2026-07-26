import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router';
import { useSessionStore } from '@/stores/session';

/**
 * Phase 0 has no identity. Users, roles, TOTP and the scope resolver are
 * Phase 1, so the guard below is wired and tested but not yet enforcing:
 * with nothing able to authenticate, enforcing it would leave an unreachable
 * shell and no way to see the app at all.
 *
 * Phase 1 flips this to true. Nothing else about the guard changes.
 */
export const AUTH_ENFORCED = false;

const routes: RouteRecordRaw[] = [
  {
    path: '/sign-in',
    name: 'sign-in',
    component: () => import('@/views/SignInView.vue'),
    meta: { requiresAuth: false, title: 'Sign in' },
  },
  {
    path: '/',
    component: () => import('@/components/AppShell.vue'),
    children: [
      {
        path: '',
        name: 'today',
        component: () => import('@/views/TodayView.vue'),
        meta: { requiresAuth: true, title: 'Today' },
      },
      {
        path: 'participants',
        name: 'participants',
        component: () => import('@/views/ParticipantsView.vue'),
        meta: { requiresAuth: true, title: 'Participants' },
      },
      {
        path: 'system',
        name: 'system',
        component: () => import('@/views/SystemView.vue'),
        meta: { requiresAuth: true, title: 'System' },
      },
    ],
  },
  {
    path: '/:pathMatch(.*)*',
    name: 'not-found',
    component: () => import('@/views/NotFoundView.vue'),
    meta: { requiresAuth: false, title: 'Page not found' },
  },
];

export const router = createRouter({
  history: createWebHistory(),
  routes,
  scrollBehavior: () => ({ top: 0 }),
});

router.beforeEach((to) => {
  const session = useSessionStore();

  if (AUTH_ENFORCED && to.meta.requiresAuth && !session.isAuthenticated) {
    return { name: 'sign-in', query: { redirect: to.fullPath } };
  }
  return true;
});

router.afterEach((to) => {
  const title = typeof to.meta.title === 'string' ? to.meta.title : null;
  document.title = title ? `${title} · Vigilo` : 'Vigilo';
});
