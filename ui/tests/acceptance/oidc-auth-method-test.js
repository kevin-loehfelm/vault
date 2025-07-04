/**
 * Copyright (c) HashiCorp, Inc.
 * SPDX-License-Identifier: BUSL-1.1
 */
import { module, test } from 'qunit';
import { setupApplicationTest } from 'ember-qunit';
import { click, fillIn, find, waitUntil } from '@ember/test-helpers';
import { logout } from 'vault/tests/helpers/auth/auth-helpers';
import { setupMirage } from 'ember-cli-mirage/test-support';
import { buildMessage, callbackData, windowStub } from 'vault/tests/helpers/oidc-window-stub';
import sinon from 'sinon';
import { Response } from 'miragejs';
import { setupTotpMfaResponse } from 'vault/tests/helpers/mfa/mfa-helpers';
import { AUTH_FORM } from 'vault/tests/helpers/auth/auth-form-selectors';
import { GENERAL } from 'vault/tests/helpers/general-selectors';
import { ERROR_MISSING_PARAMS, ERROR_WINDOW_CLOSED } from 'vault/components/auth-jwt';

const DELAY_IN_MS = 500;

module('Acceptance | oidc auth method', function (hooks) {
  setupApplicationTest(hooks);
  setupMirage(hooks);

  hooks.beforeEach(function () {
    this.openStub = windowStub();

    this.setupMocks = (assert) => {
      this.server.post('/auth/oidc/oidc/auth_url', () => ({
        data: { auth_url: 'http://example.com' },
      }));
      // there was a bug that would result in the /auth/:path/login endpoint hit with an empty payload rather than lookup-self
      // ensure that the correct endpoint is hit after the oidc callback
      if (assert) {
        this.server.get('/auth/token/lookup-self', (schema, req) => {
          assert.ok(true, 'request made to auth/token/lookup-self after oidc callback');
          req.passthrough();
        });
      }
    };

    this.server.get('/auth/foo/oidc/callback', () => ({
      auth: { client_token: 'root' },
    }));

    // select method from dropdown or click auth path tab
    this.selectMethod = async (method, useLink) => {
      if (useLink) {
        await click(`[data-test-auth-method-link="${method}"]`);
      } else {
        await fillIn('[data-test-select="auth-method"]', method);
      }
    };

    // ensure clean state
    localStorage.removeItem('selectedAuth');
    // Cannot log out here because it will cause the internal mount request to be hit before the mocks can interrupt it
  });

  hooks.afterEach(async function () {
    this.openStub.restore();
  });

  test('it should login with oidc when selected from auth methods dropdown', async function (assert) {
    assert.expect(1);
    this.setupMocks(assert);
    await logout();
    await this.selectMethod('oidc');

    setTimeout(() => {
      window.postMessage(buildMessage().data, window.origin);
    }, DELAY_IN_MS);

    await click(AUTH_FORM.login);
  });

  test('it should login with oidc from listed auth mount tab', async function (assert) {
    assert.expect(3);
    this.setupMocks(assert);

    this.server.get('/sys/internal/ui/mounts', () => ({
      data: {
        auth: {
          'test-path/': { description: '', options: {}, type: 'oidc' },
        },
      },
    }));
    // this request is fired twice -- total assertion count should be 3 rather than 2
    // JLR TODO - auth-jwt: verify whether additional request is necessary, especially when glimmerizing component
    // look into whether didReceiveAttrs is necessary to trigger this request
    this.server.post('/auth/test-path/oidc/auth_url', () => {
      assert.ok(true, 'auth_url request made to correct non-standard mount path');
      return { data: { auth_url: 'http://example.com' } };
    });

    await logout();
    await this.selectMethod('oidc', true);
    setTimeout(() => {
      window.postMessage(buildMessage().data, window.origin);
    }, DELAY_IN_MS);
    await click(AUTH_FORM.login);
  });

  // coverage for bug where token was selected as auth method for oidc and jwt
  test('it should populate oidc auth method on logout', async function (assert) {
    this.setupMocks();
    await logout();
    await this.selectMethod('oidc');

    setTimeout(() => {
      window.postMessage(buildMessage().data, window.origin);
    }, 500);

    await click(AUTH_FORM.login);
    assert
      .dom('[data-test-dashboard-card-header="Vault version"]')
      .exists('Render the dashboard landing page.');

    await logout();
    assert
      .dom('[data-test-select="auth-method"]')
      .hasValue('oidc', 'Previous auth method selected on logout');
  });

  test('it should fetch role when switching between oidc/jwt auth methods and changing the mount path', async function (assert) {
    await logout();
    let reqCount = 0;
    this.server.post('/auth/:method/oidc/auth_url', (schema, req) => {
      reqCount++;
      const errors =
        req.params.method === 'jwt' ? ['OIDC login is not configured for this mount'] : ['missing role'];
      return new Response(400, {}, { errors });
    });

    await this.selectMethod('oidc');
    assert.dom(GENERAL.inputByAttr('jwt')).doesNotExist('JWT Token input hidden for OIDC');
    await this.selectMethod('jwt');
    assert.dom(GENERAL.inputByAttr('jwt')).exists('JWT Token input renders for JWT configured method');
    await click('[data-test-auth-form-options-toggle]');
    await fillIn(GENERAL.inputByAttr('path'), 'foo');
    assert.strictEqual(reqCount, 3, 'Role is fetched when dependant values are changed');
  });

  test('it should display role fetch errors when signing in with OIDC', async function (assert) {
    this.server.post('/auth/:method/oidc/auth_url', (schema, req) => {
      const { role } = JSON.parse(req.requestBody);
      const status = role ? 403 : 400;
      const errors = role ? ['permission denied'] : ['missing role'];
      return new Response(status, {}, { errors });
    });
    await logout();
    await this.selectMethod('oidc');
    await click(AUTH_FORM.login);
    assert.dom('[data-test-message-error-description]').hasText('Invalid role. Please try again.');

    await fillIn(GENERAL.inputByAttr('role'), 'test');
    await click(AUTH_FORM.login);
    assert.dom('[data-test-message-error-description]').hasText('Error fetching role: permission denied');
  });

  test('it prompts mfa if configured', async function (assert) {
    assert.expect(1);

    this.setupMocks(assert);
    this.server.get('/auth/foo/oidc/callback', () => setupTotpMfaResponse('foo'));
    await logout();
    await this.selectMethod('oidc');
    setTimeout(() => {
      window.postMessage(buildMessage().data, window.origin);
    }, DELAY_IN_MS);

    await click(AUTH_FORM.login);
    await waitUntil(() => find('[data-test-mfa-form]'));
    assert.dom('[data-test-mfa-form]').exists('it renders TOTP MFA form');
  });

  test('auth service is called with client_token and cluster data', async function (assert) {
    const authSpy = sinon.spy(this.owner.lookup('service:auth'), 'authenticate');
    this.setupMocks();
    await logout();
    await this.selectMethod('oidc');
    setTimeout(() => {
      window.postMessage(buildMessage().data, window.origin);
    }, DELAY_IN_MS);
    await click(AUTH_FORM.login);
    const [actual] = authSpy.lastCall.args;
    const expected = {
      // even though this is the oidc auth method,
      // the callback has returned a token at this point of the login flow
      // and so the backend is 'token'
      backend: 'token',
      clusterId: '1',
      data: {
        // data from oidc/callback url
        mfa_requirement: undefined,
        token: 'root',
      },
      selectedAuth: 'oidc',
    };

    assert.propEqual(
      actual,
      expected,
      `authenticate method called with correct args, ${JSON.stringify({ actual, expected })}`
    );
  });

  // test case for https://github.com/hashicorp/vault/issues/12436
  test('it should ignore messages sent from outside the app while waiting for oidc callback', async function (assert) {
    assert.expect(3); // one for both message events (2) and one for callback request
    this.setupMocks();
    this.server.get('/auth/foo/oidc/callback', () => {
      // third assertion
      assert.true(true, 'request is made to callback url');
      return { auth: { client_token: 'root' } };
    });

    let count = 0;
    const assertEvent = (event) => {
      count++;
      // we have to use the same event method, but need to update what it checks for depending on when it's called
      const source = count === 1 ? 'miscellaneous-source' : 'oidc-callback';
      assert.strictEqual(event.data.source, source, `message event fires with source: ${event.data.source}`);
    };
    window.addEventListener('message', assertEvent);
    await logout();
    await this.selectMethod('oidc');

    setTimeout(() => {
      // first assertion
      window.postMessage(callbackData({ source: 'miscellaneous-source' }), window.origin);
      // second assertion
      window.postMessage(callbackData({ source: 'oidc-callback' }), window.origin);
    }, DELAY_IN_MS);

    await click(AUTH_FORM.login);
    // cleanup
    window.removeEventListener('message', assertEvent);
  });

  test('it shows error when message posted with state key, wrong params', async function (assert) {
    this.setupMocks();
    await logout();
    await this.selectMethod('oidc');
    setTimeout(() => {
      // callback params are missing "code"
      window.postMessage({ source: 'oidc-callback', state: 'state', foo: 'bar' }, window.origin);
    }, DELAY_IN_MS);
    await click(AUTH_FORM.login);
    assert
      .dom(GENERAL.messageError)
      .hasText(`Error ${ERROR_MISSING_PARAMS}`, 'displays error when missing params');
  });

  test('it shows error when popup is closed', async function (assert) {
    windowStub({ stub: this.openStub, popup: { closed: true, close: () => {} } });

    this.setupMocks();
    await logout();
    await this.selectMethod('oidc');
    await click(AUTH_FORM.login);
    assert
      .dom(GENERAL.messageError)
      .hasText(`Error ${ERROR_WINDOW_CLOSED}`, 'displays error when missing params');
  });
});
