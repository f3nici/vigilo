import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import {
  createHarness,
  resetData,
  seedUser,
  signIn,
  VENT_SCHEMA,
  type Harness,
  type SignedIn,
} from './helpers.js';

/**
 * Check templates (doc 04 §5).
 *
 * The rule under test throughout: a published version is immutable, and
 * publishing supersedes rather than overwrites. Everything else follows from
 * February's records still having to render with February's fields.
 */
describe('check templates', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await createHarness();
  });

  afterAll(async () => {
    await h.close();
  });

  beforeEach(async () => {
    await resetData(h.ownerDb);
  });

  function api(session: SignedIn, method: 'get' | 'post' | 'patch', path: string) {
    return request(h.app)
      [method](path)
      .set('Cookie', session.cookies)
      .set('X-CSRF-Token', session.csrfToken);
  }

  async function adminSession(): Promise<SignedIn> {
    return signIn(h, await seedUser(h.ownerDb, h.keyRing, { role: 'admin' }));
  }

  /** A published template, which most tests need before they can do anything. */
  async function publishedTemplate(
    session: SignedIn,
  ): Promise<{ templateId: string; versionId: string }> {
    const created = await api(session, 'post', '/api/v1/check-templates').send({
      name: 'Vent observations',
      description: '2-hourly ventilator checks',
    });
    expect(created.status).toBe(201);

    const templateId = created.body.template.id as string;
    const versionId = created.body.template.draftVersion.id as string;

    const saved = await api(session, 'patch', `/api/v1/check-template-versions/${versionId}`).send({
      schema: VENT_SCHEMA,
    });
    expect(saved.status).toBe(200);

    const published = await api(
      session,
      'post',
      `/api/v1/check-template-versions/${versionId}/publish`,
    ).send({});
    expect(published.status).toBe(200);

    return { templateId, versionId };
  }

  it('creates a template with an empty draft ready to edit', async () => {
    const session = await adminSession();

    const response = await api(session, 'post', '/api/v1/check-templates').send({
      name: 'Vent observations',
    });

    expect(response.status).toBe(201);
    expect(response.body.template.draftVersion.version).toBe(1);
    expect(response.body.template.draftVersion.schema.fields).toEqual([]);
    expect(response.body.template.publishedVersion).toBeNull();
  });

  it('publishes a draft and reports it as the published version', async () => {
    const session = await adminSession();
    const { templateId } = await publishedTemplate(session);

    const response = await api(session, 'get', `/api/v1/check-templates/${templateId}`);
    expect(response.body.template.publishedVersion.version).toBe(1);
    expect(response.body.template.publishedVersion.schema.fields).toHaveLength(4);
    expect(response.body.template.draftVersion).toBeNull();
  });

  /** The rule this whole file exists for. */
  it('refuses to change a published version', async () => {
    const session = await adminSession();
    const { versionId } = await publishedTemplate(session);

    const response = await api(
      session,
      'patch',
      `/api/v1/check-template-versions/${versionId}`,
    ).send({
      schema: { fields: [] },
    });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('conflict');
  });

  it('supersedes the previous version rather than deleting it', async () => {
    const session = await adminSession();
    const { templateId, versionId } = await publishedTemplate(session);

    const draft = await api(session, 'post', `/api/v1/check-templates/${templateId}/versions`).send(
      {},
    );
    expect(draft.status).toBe(201);
    expect(draft.body.version.version).toBe(2);
    // The draft starts as a copy of what staff are using.
    expect(draft.body.version.schema.fields).toHaveLength(4);

    await api(
      session,
      'post',
      `/api/v1/check-template-versions/${draft.body.version.id}/publish`,
    ).send({});

    const versions = await api(session, 'get', `/api/v1/check-templates/${templateId}/versions`);
    const byId = new Map(
      (versions.body.versions as { id: string; status: string }[]).map((one) => [
        one.id,
        one.status,
      ]),
    );
    expect(byId.get(versionId)).toBe('superseded');
    expect(byId.get(draft.body.version.id as string)).toBe('published');
  });

  it('hands back the existing draft rather than opening a second one', async () => {
    const session = await adminSession();
    const { templateId } = await publishedTemplate(session);

    const first = await api(session, 'post', `/api/v1/check-templates/${templateId}/versions`).send(
      {},
    );
    const second = await api(
      session,
      'post',
      `/api/v1/check-templates/${templateId}/versions`,
    ).send({});

    expect(second.body.version.id).toBe(first.body.version.id);
  });

  it('shows the diff before publishing', async () => {
    const session = await adminSession();
    const { templateId } = await publishedTemplate(session);

    const draft = await api(session, 'post', `/api/v1/check-templates/${templateId}/versions`).send(
      {},
    );
    const draftId = draft.body.version.id as string;

    await api(session, 'patch', `/api/v1/check-template-versions/${draftId}`).send({
      schema: {
        fields: [
          ...VENT_SCHEMA.fields.filter((field) => field.key !== 'comment'),
          {
            key: 'weight',
            label: 'Weight',
            type: 'number',
            unit: 'kg',
            decimals: 1,
            required: false,
            sort: 50,
          },
        ],
      },
    });

    const preview = await api(
      session,
      'get',
      `/api/v1/check-template-versions/${draftId}/publish-preview`,
    );
    expect(preview.body.diff.added).toEqual(['weight']);
    expect(preview.body.diff.removed).toEqual(['comment']);
    expect(preview.body.problems).toEqual([]);
  });

  it('refuses to publish an empty form', async () => {
    const session = await adminSession();
    const created = await api(session, 'post', '/api/v1/check-templates').send({ name: 'Empty' });
    const versionId = created.body.template.draftVersion.id as string;

    const response = await api(
      session,
      'post',
      `/api/v1/check-template-versions/${versionId}/publish`,
    ).send({});

    expect(response.status).toBe(422);
    expect(response.body.error.message).toContain('at least one field');
  });

  /**
   * Doc 03 §4. Otherwise February's numbers get read back through March's
   * option list.
   */
  it('refuses to republish a key as a different type', async () => {
    const session = await adminSession();
    const { templateId } = await publishedTemplate(session);

    const draft = await api(session, 'post', `/api/v1/check-templates/${templateId}/versions`).send(
      {},
    );
    const draftId = draft.body.version.id as string;

    await api(session, 'patch', `/api/v1/check-template-versions/${draftId}`).send({
      schema: {
        fields: [
          {
            key: 'urine_output',
            label: 'Urine output',
            type: 'text',
            multiline: false,
            maxLength: 50,
            required: true,
            sort: 10,
          },
        ],
      },
    });

    const response = await api(
      session,
      'post',
      `/api/v1/check-template-versions/${draftId}/publish`,
    ).send({});
    expect(response.status).toBe(422);
    expect(response.body.error.message).toContain('published as a number field');
  });

  /**
   * D14. The wire schema is strict, so there is nowhere to put a normal range
   * even by hand-editing the request.
   */
  it('refuses a normal range on a field', async () => {
    const session = await adminSession();
    const created = await api(session, 'post', '/api/v1/check-templates').send({ name: 'Obs' });
    const versionId = created.body.template.draftVersion.id as string;

    const response = await api(
      session,
      'patch',
      `/api/v1/check-template-versions/${versionId}`,
    ).send({
      schema: {
        fields: [
          {
            key: 'reading',
            label: 'Reading',
            type: 'number',
            unit: 'ml',
            decimals: 0,
            required: true,
            sort: 10,
            normalRange: { low: 300, high: 800 },
          },
        ],
      },
    });

    expect(response.status).toBe(422);
  });

  it('lets a nurse manage templates but not a worker', async () => {
    const admin = await adminSession();
    const { templateId } = await publishedTemplate(admin);

    const nurse = await signIn(h, await seedUser(h.ownerDb, h.keyRing, { role: 'nurse' }));
    const worker = await signIn(h, await seedUser(h.ownerDb, h.keyRing, { role: 'worker' }));

    const nurseDraft = await api(
      nurse,
      'post',
      `/api/v1/check-templates/${templateId}/versions`,
    ).send({});
    expect(nurseDraft.status).toBe(201);

    const workerDraft = await api(
      worker,
      'post',
      `/api/v1/check-templates/${templateId}/versions`,
    ).send({});
    expect(workerDraft.status).toBe(403);

    // A worker still reads them, because their device renders the form.
    const workerList = await api(worker, 'get', '/api/v1/check-templates');
    expect(workerList.status).toBe(200);
    expect(workerList.body.templates).toHaveLength(1);
  });

  it('refuses to retire a form a schedule is still using', async () => {
    const session = await adminSession();
    const { templateId } = await publishedTemplate(session);

    const participant = await request(h.app)
      .post('/api/v1/participants')
      .set('Cookie', session.cookies)
      .set('X-CSRF-Token', session.csrfToken)
      .send({
        firstName: 'Alice',
        lastName: 'Smith',
        dateOfBirth: '1994-03-02',
        ndisNumber: '431234567',
      });

    await api(
      session,
      'post',
      `/api/v1/participants/${participant.body.participant.id}/schedules`,
    ).send({
      templateId,
      name: 'Vent observations',
      activeFrom: '2026-07-01',
      segments: [
        {
          windowMinutes: 120,
          anchorTime: '07:00',
          appliesFromTime: '07:00',
          appliesToTime: '21:00',
        },
      ],
    });

    const response = await api(session, 'patch', `/api/v1/check-templates/${templateId}`).send({
      status: 'retired',
    });

    expect(response.status).toBe(409);
    expect(response.body.error.message).toContain('still using this check form');
  });

  it('audits creation and publication', async () => {
    const session = await adminSession();
    await publishedTemplate(session);

    const rows = await h.ownerDb.execute<{ action: string }>(
      `select action from audit_log where action like 'template.%' order by id`,
    );
    expect(rows.map((row) => row.action)).toEqual([
      'template.create',
      'template.draft_update',
      'template.publish',
    ]);
  });
});
