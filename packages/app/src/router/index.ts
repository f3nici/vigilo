import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router';
import { useSessionStore } from '@/stores/session';
import { useOfflineStore } from '@/stores/offline';

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
    path: '/install',
    name: 'install',
    component: () => import('@/views/InstallView.vue'),
    meta: { requiresAuth: true, title: 'Install Vigilo' },
  },
  {
    /*
     * Reachable while locked, because it is the screen that unlocks. It also
     * has to work with no signal: the records are already on the device and
     * the whole point is getting at them without a network.
     */
    path: '/unlock',
    name: 'unlock',
    component: () => import('@/views/UnlockView.vue'),
    meta: { requiresAuth: true, allowLocked: true, title: 'Unlock' },
  },
  {
    path: '/',
    component: () => import('@/components/AppShell.vue'),
    children: [
      {
        path: '',
        name: 'today',
        // The manifest's start_url is /today, so an installed app opens
        // straight onto the screen a worker is going to rather than through a
        // redirect the user watches happen.
        alias: 'today',
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
        path: 'participants/new',
        name: 'participant-new',
        component: () => import('@/views/ParticipantFormView.vue'),
        meta: { requiresAuth: true, roles: ['admin'], title: 'Add a participant' },
      },
      {
        path: 'participants/:id',
        name: 'participant',
        component: () => import('@/views/ParticipantView.vue'),
        meta: { requiresAuth: true, title: 'Participant' },
      },
      {
        path: 'participants/:id/edit',
        name: 'participant-edit',
        component: () => import('@/views/ParticipantFormView.vue'),
        meta: { requiresAuth: true, roles: ['admin'], title: 'Edit participant' },
      },
      {
        path: 'participants/:id/schedule',
        name: 'participant-schedule',
        component: () => import('@/views/ScheduleEditorView.vue'),
        meta: { requiresAuth: true, roles: ['admin', 'team_leader'], title: 'Check schedule' },
      },
      {
        path: 'participants/:id/medications',
        name: 'participant-medications',
        component: () => import('@/views/MedicationsView.vue'),
        // Deciding what somebody takes is a clinical judgement, so this sits
        // with the nurse and the admin, where care plan authorship sits.
        meta: { requiresAuth: true, roles: ['admin', 'nurse'], title: 'Medication chart' },
      },
      {
        path: 'participants/:id/coverage',
        name: 'participant-coverage',
        component: () => import('@/views/CoverageView.vue'),
        meta: { requiresAuth: true, roles: ['admin', 'team_leader'], title: 'Coverage' },
      },
      {
        path: 'windows/:id',
        name: 'window',
        component: () => import('@/views/WindowView.vue'),
        meta: { requiresAuth: true, title: 'Check' },
      },
      {
        path: 'check-forms',
        name: 'check-templates',
        component: () => import('@/views/CheckTemplatesView.vue'),
        meta: { requiresAuth: true, title: 'Check forms' },
      },
      {
        path: 'check-forms/:id',
        name: 'check-template',
        component: () => import('@/views/TemplateBuilderView.vue'),
        meta: { requiresAuth: true, roles: ['admin', 'nurse'], title: 'Field builder' },
      },
      {
        path: 'reports',
        name: 'reports',
        component: () => import('@/views/ReportsView.vue'),
        // A worker records care; they do not report on it. The API says the
        // same thing, and this is so they are not shown a screen that 403s.
        meta: { requiresAuth: true, roles: ['admin', 'team_leader', 'nurse'], title: 'Reports' },
      },
      {
        path: 'diary-categories',
        name: 'diary-categories',
        component: () => import('@/views/DiaryCategoriesView.vue'),
        meta: { requiresAuth: true, roles: ['admin'], title: 'Diary categories' },
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

      /*
       * Participant self-access (doc 06 §6). The only three screens that role
       * can reach, and the only three screens no other role can: a worker
       * opening My day would be asking the API for a record their account is
       * not the subject of.
       */
      {
        path: 'my-day',
        name: 'my-day',
        component: () => import('@/views/MyDayView.vue'),
        meta: { requiresAuth: true, roles: ['participant'], title: 'My day' },
      },
      {
        path: 'my-records',
        name: 'my-records',
        component: () => import('@/views/MyRecordsView.vue'),
        meta: { requiresAuth: true, roles: ['participant'], title: 'My records' },
      },
      {
        path: 'my-reports',
        name: 'my-reports',
        component: () => import('@/views/MyReportsView.vue'),
        meta: { requiresAuth: true, roles: ['participant'], title: 'My reports' },
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
 * The screen a role belongs on.
 *
 * A participant's home is their own day. Sending them to Today, which is a
 * worker's list of checks to do, would be sending them to a screen that has
 * nothing on it and could not have anything on it.
 */
export function homeFor(role: string | undefined): 'today' | 'my-day' {
  return role === 'participant' ? 'my-day' : 'today';
}

/**
 * The three screens a self-access account may reach, plus the routes that
 * resolve an outstanding requirement.
 *
 * The API refuses everything else for this role, so without this a participant
 * following an old link would get a screen full of failed requests instead of
 * their record. The server is still the authority; this is so nobody is shown
 * a wall of errors to discover it.
 */
export const SELF_ACCESS_ROUTES = new Set([
  'my-day',
  'my-records',
  'my-reports',
  'set-password',
  'set-up-two-factor',
  'install',
  'not-found',
]);

/**
 * The guard mirrors what the API enforces. The server is the authority; this
 * exists so a user is taken to the step they need rather than shown an error.
 */
router.beforeEach(async (to) => {
  const session = useSessionStore();
  await session.ensureLoaded();

  const home = homeFor(session.principal?.role);

  if (!to.meta.requiresAuth) {
    // A signed-in user has no reason to sit on the sign-in screen.
    if (to.name === 'sign-in' && session.isAuthenticated) return { name: home };
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
    return { name: home };
  }

  /*
   * Most staff screens carry no `roles` meta, because every staff role uses
   * them. A participant has to be turned away by name rather than by the
   * absence of a rule.
   */
  if (session.principal?.role === 'participant' && !SELF_ACCESS_ROUTES.has(String(to.name))) {
    return { name: 'my-day' };
  }

  /*
   * A device that has an unlock set up but is not unlocked cannot read its own
   * records: they are encrypted with a key the unlock derives. So every screen
   * except the unlock itself waits behind it.
   *
   * A self-access account holds no records on the device, so there is nothing
   * for an unlock to decrypt and nothing to wait for.
   */
  const offline = useOfflineStore();
  if (
    !to.meta.allowLocked &&
    offline.state === 'locked' &&
    session.principal?.role !== 'participant'
  ) {
    return { name: 'unlock' };
  }

  return true;
});

router.afterEach((to) => {
  const title = typeof to.meta.title === 'string' ? to.meta.title : null;
  document.title = title ? `${title} · Vigilo` : 'Vigilo';
});
