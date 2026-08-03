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

  /* -------------------------------------------------- export and import */

  it('exports the published form as a portable document', async () => {
    const session = await adminSession();
    await publishedTemplate(session);

    const response = await api(session, 'get', '/api/v1/check-templates/export');

    expect(response.status).toBe(200);
    expect(response.headers['content-disposition']).toContain('vigilo-check-forms-');
    expect(response.body.kind).toBe('vigilo.check-forms');
    expect(response.body.version).toBe(1);
    expect(response.body.forms).toHaveLength(1);
    expect(response.body.forms[0].name).toBe('Vent observations');
    expect(response.body.forms[0].schema.fields).toHaveLength(4);
    // Identity stays behind: an imported form is a new form where it lands.
    expect(Object.keys(response.body.forms[0]).sort()).toEqual(['description', 'name', 'schema']);
  });

  it('exports a chosen form rather than all of them', async () => {
    const session = await adminSession();
    const { templateId } = await publishedTemplate(session);
    await api(session, 'post', '/api/v1/check-templates').send({ name: 'Something else' });

    const response = await api(session, 'get', `/api/v1/check-templates/export?ids=${templateId}`);

    expect(response.status).toBe(200);
    expect(response.body.forms.map((form: { name: string }) => form.name)).toEqual([
      'Vent observations',
    ]);
  });

  it('imports a document as a draft, never as something workers can see', async () => {
    const session = await adminSession();
    await publishedTemplate(session);
    const exported = await api(session, 'get', '/api/v1/check-templates/export');

    // A fresh installation: everything gone, the file is all that is left.
    await resetData(h.ownerDb);
    const fresh = await adminSession();

    const response = await api(fresh, 'post', '/api/v1/check-templates/import').send(exported.body);

    expect(response.status).toBe(201);
    expect(response.body.imported).toHaveLength(1);
    expect(response.body.imported[0].name).toBe('Vent observations');
    expect(response.body.imported[0].fieldCount).toBe(4);

    const listed = await api(fresh, 'get', '/api/v1/check-templates');
    const template = listed.body.templates[0];
    expect(template.publishedVersion).toBeNull();
    expect(template.draftVersion.schema.fields).toHaveLength(4);
  });

  /** Importing the same file twice is untidy, never destructive. */
  it('marks a name collision instead of touching the form already there', async () => {
    const session = await adminSession();
    const { templateId } = await publishedTemplate(session);
    const exported = await api(session, 'get', '/api/v1/check-templates/export');

    const response = await api(session, 'post', '/api/v1/check-templates/import').send(
      exported.body,
    );

    expect(response.status).toBe(201);
    expect(response.body.imported[0].name).toBe('Vent observations (imported)');
    expect(response.body.imported[0].originalName).toBe('Vent observations');
    expect(response.body.imported[0].id).not.toBe(templateId);

    const original = await api(session, 'get', `/api/v1/check-templates/${templateId}`);
    expect(original.body.template.publishedVersion.version).toBe(1);
    expect(original.body.template.draftVersion).toBeNull();
  });

  it('refuses a file it cannot read rather than importing half of it', async () => {
    const session = await adminSession();

    const wrongVersion = await api(session, 'post', '/api/v1/check-templates/import').send({
      kind: 'vigilo.check-forms',
      version: 2,
      exportedAt: new Date().toISOString(),
      forms: [{ name: 'From the future', description: null, schema: { fields: [] } }],
    });
    expect(wrongVersion.status).toBe(422);

    const smuggled = await api(session, 'post', '/api/v1/check-templates/import').send({
      kind: 'vigilo.check-forms',
      version: 1,
      exportedAt: new Date().toISOString(),
      forms: [
        { name: 'One good form', description: null, schema: { fields: [] } },
        {
          name: 'One bad form',
          description: null,
          // D14: there is nowhere in the schema for a range, including here.
          schema: {
            fields: [
              {
                key: 'spo2',
                label: 'SpO2',
                type: 'number',
                unit: '%',
                decimals: 0,
                sort: 10,
                required: true,
                normalRange: [95, 100],
              },
            ],
          },
        },
      ],
    });
    expect(smuggled.status).toBe(422);

    const listed = await api(session, 'get', '/api/v1/check-templates');
    expect(listed.body.templates).toHaveLength(0);
  });

  it('renames a form without touching the version its entries point at', async () => {
    const session = await adminSession();
    const { templateId } = await publishedTemplate(session);

    const response = await api(session, 'patch', `/api/v1/check-templates/${templateId}`).send({
      name: 'Ventilator observations',
      description: 'Every two hours',
    });

    expect(response.status).toBe(200);
    expect(response.body.template.name).toBe('Ventilator observations');
    expect(response.body.template.description).toBe('Every two hours');
    // The name is not versioned, so nothing about the published form moved.
    expect(response.body.template.publishedVersion.version).toBe(1);
    expect(response.body.template.publishedVersion.schema.fields).toHaveLength(4);
    expect(response.body.template.draftVersion).toBeNull();
  });

  /** The rename must not undo what the import went out of its way to avoid. */
  it('refuses a rename onto the name of another active form', async () => {
    const session = await adminSession();
    await publishedTemplate(session);
    const other = await api(session, 'post', '/api/v1/check-templates').send({
      name: 'Bowel chart',
    });

    const response = await api(
      session,
      'patch',
      `/api/v1/check-templates/${other.body.template.id}`,
    ).send({ name: 'Vent observations' });

    expect(response.status).toBe(409);
    expect(response.body.error.message).toContain('already called that');
  });

  it('lets a form keep its own name while its description changes', async () => {
    const session = await adminSession();
    const { templateId } = await publishedTemplate(session);

    const response = await api(session, 'patch', `/api/v1/check-templates/${templateId}`).send({
      name: 'Vent observations',
      description: 'Reworded',
    });

    expect(response.status).toBe(200);
    expect(response.body.template.description).toBe('Reworded');
  });

  it('lets an imported form be renamed to the name it wanted', async () => {
    const session = await adminSession();
    const { templateId } = await publishedTemplate(session);
    const exported = await api(session, 'get', '/api/v1/check-templates/export');

    const importResponse = await api(session, 'post', '/api/v1/check-templates/import').send(
      exported.body,
    );
    const copy = importResponse.body.imported[0];
    expect(copy.name).toBe('Vent observations (imported)');

    // The original has to go first, which is the whole point of the guard.
    const blocked = await api(session, 'patch', `/api/v1/check-templates/${copy.id}`).send({
      name: 'Vent observations',
    });
    expect(blocked.status).toBe(409);

    await api(session, 'patch', `/api/v1/check-templates/${templateId}`).send({
      status: 'retired',
    });

    const renamed = await api(session, 'patch', `/api/v1/check-templates/${copy.id}`).send({
      name: 'Vent observations',
    });
    expect(renamed.status).toBe(200);
    expect(renamed.body.template.name).toBe('Vent observations');
  });

  it('keeps export and import to the people who manage forms', async () => {
    const worker = await signIn(h, await seedUser(h.ownerDb, h.keyRing, { role: 'worker' }));

    expect((await api(worker, 'get', '/api/v1/check-templates/export')).status).toBe(403);
    expect(
      (
        await api(worker, 'post', '/api/v1/check-templates/import').send({
          kind: 'vigilo.check-forms',
          version: 1,
          exportedAt: new Date().toISOString(),
          forms: [{ name: 'Sneaky', description: null, schema: { fields: [] } }],
        })
      ).status,
    ).toBe(403);
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
