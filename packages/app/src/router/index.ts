import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router';
import { useSessionStore } from '@/stores/session';

const routes: RouteRecordRaw[] = [
  {
    path: '/sign-in',
    name: 'sign-in',
    component: () => import('@/views/SignInView.vue'),
    meta: { requiresAuth: false, title: 'Sign in' },
  },
  {
    path: '/set-password',
    name: 'set-password',
    component: () => import('@/views/SetPasswordView.vue'),
    // Reachable while a requirement is outstanding: it is how you resolve one.
    meta: { requiresAuth: true, allowPending: true, title: 'Change your password' },
  },
  {
    path: '/set-up-two-factor',
    name: 'set-up-two-factor',
    component: () => import('@/views/TotpEnrolView.vue'),
    meta: { requiresAuth: true, allowPending: true, title: 'Set up two-factor' },
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
        path: 'users',
        name: 'users',
        component: () => import('@/views/UsersView.vue'),
        meta: { requiresAuth: true, roles: ['admin'], title: 'People' },
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

/**
 * The guard mirrors what the API enforces. The server is the authority; this
 * exists so a user is taken to the step they need rather than shown an error.
 */
router.beforeEach(async (to) => {
  const session = useSessionStore();
  await session.ensureLoaded();

  if (!to.meta.requiresAuth) {
    // A signed-in user has no reason to sit on the sign-in screen.
    if (to.name === 'sign-in' && session.isAuthenticated) return { name: 'today' };
    return true;
  }

  if (!session.isAuthenticated) {
    return { name: 'sign-in', query: { redirect: to.fullPath } };
  }

  // An outstanding requirement wins over everything except the route that
  // resolves it.
  if (!to.meta.allowPending) {
    if (session.pendingStep === 'password') return { name: 'set-password' };
    if (session.pendingStep === 'totp') return { name: 'set-up-two-factor' };
  }

  const allowed = to.meta.roles as string[] | undefined;
  if (allowed && session.principal && !allowed.includes(session.principal.role)) {
    return { name: 'today' };
  }

  return true;
});

router.afterEach((to) => {
  const title = typeof to.meta.title === 'string' ? to.meta.title : null;
  document.title = title ? `${title} · Vigilo` : 'Vigilo';
});
