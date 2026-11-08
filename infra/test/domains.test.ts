// Custom domains (CAP-29): CloudFront alias + API Gateway domain from config, ACM certificate ARNs from SSM, CORS
// without Fn::ImportValue when domains are set, and today's default URLs when they are not.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../lib/app.js';
import { settingParameterName, UNSET_PARAMETER_VALUE } from '../lib/collectors-data-stack.js';
import { applyDomainsSwitch, type InstallationConfig, loadInstallationConfig } from '../lib/config.js';
import { CERTIFICATE_SETTINGS } from '../lib/routes.js';

const ENV_KEYS = ['CDK_DEFAULT_ACCOUNT', 'CAP_ACCOUNT_NAEVA_DEV', 'CAP_INSTALLATION', 'CAP_STAGE'];
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const deployment = { installation: 'naeva', stage: 'dev' };
/** Unit tests never run esbuild (CI `npm run synth` bundles for real). */
const NO_BUNDLING = { 'aws:cdk:bundling-stacks': [] };

/** A config dir holding only naeva.dev.json with the given content. */
function configDir(content: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'cap-domains-'));
  writeFileSync(join(dir, 'naeva.dev.json'), JSON.stringify(content));
  return dir;
}

const BASE = {
  config_version: 'test',
  region: 'eu-west-1',
  app_origins: ['capacitor://localhost'],
  ai: { modelId: 'anthropic.claude-test-v1:0', dhashThreshold: 10 },
  ops: { budgetEur: 10, logRetentionDays: 30 },
};
const DOMAINS = { web: 'caps.naevatec.com', api: 'api.caps.naevatec.com' };

function synth(opts: { domains?: typeof DOMAINS; context?: Record<string, unknown> } = {}) {
  const app = new App({ context: { ...NO_BUNDLING, ...deployment, ...opts.context } });
  const built = buildApp(app, configDir({ ...BASE, ...(opts.domains && { domains: opts.domains }) }));
  return { data: Template.fromStack(built.data), api: Template.fromStack(built.api) };
}

/** Logical ids of the SSM-typed CloudFormation parameters that resolve the given SSM names. */
function ssmParams(template: Template, names: readonly string[]): string[] {
  const params = (template.toJSON().Parameters ?? {}) as Record<string, { Type: string; Default?: string }>;
  return Object.entries(params)
    .filter(([, p]) => p.Type === 'AWS::SSM::Parameter::Value<String>' && names.includes(p.Default ?? ''))
    .map(([id]) => id);
}

const CERT_PARAMS = CERTIFICATE_SETTINGS.map((n) => settingParameterName(deployment, n));
const corsOrigins = (api: Template): unknown[] => {
  const apis = Object.values(api.findResources('AWS::ApiGatewayV2::Api'));
  return (apis[0]?.Properties as { CorsConfiguration: { AllowOrigins: unknown[] } }).CorsConfiguration.AllowOrigins;
};

describe('custom domains', () => {
  it('[T-infra-024] with domains: CloudFront alias + certificate, API domain + mapping, CORS from config with no import', () => {
    const { data, api } = synth({ domains: DOMAINS });

    // Both certificate parameters exist with the placeholder; their names follow the settings convention.
    for (const name of CERT_PARAMS) {
      data.hasResourceProperties('AWS::SSM::Parameter', { Name: name, Type: 'String', Value: UNSET_PARAMETER_VALUE });
    }
    expect(CERT_PARAMS).toEqual(['/cap/naeva/dev/web-certificate-arn', '/cap/naeva/dev/api-certificate-arn']);

    // CloudFront: alias + the us-east-1 certificate ARN resolved from SSM at deploy time (never a literal).
    const [webCertParam] = ssmParams(data, ['/cap/naeva/dev/web-certificate-arn']);
    expect(webCertParam).toBeDefined();
    data.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        Aliases: ['caps.naevatec.com'],
        ViewerCertificate: Match.objectLike({ AcmCertificateArn: { Ref: webCertParam }, SslSupportMethod: 'sni-only' }),
      }),
    });
    data.hasOutput('WebUrl', { Value: 'https://caps.naevatec.com', Export: { Name: 'cap-naeva-dev-data-WebUrl' } });
    data.hasOutput('WebDomainTarget', { Value: { 'Fn::GetAtt': [Match.anyValue(), 'DomainName'] } });

    // API Gateway: regional custom domain with the regional certificate from SSM, mapped to the default stage.
    const [apiCertParam] = ssmParams(api, ['/cap/naeva/dev/api-certificate-arn']);
    expect(apiCertParam).toBeDefined();
    api.hasResourceProperties('AWS::ApiGatewayV2::DomainName', {
      DomainName: 'api.caps.naevatec.com',
      DomainNameConfigurations: [Match.objectLike({ CertificateArn: { Ref: apiCertParam }, EndpointType: 'REGIONAL' })],
    });
    api.resourceCountIs('AWS::ApiGatewayV2::ApiMapping', 1);
    api.hasResourceProperties('AWS::ApiGatewayV2::ApiMapping', { Stage: '$default' });
    api.hasOutput('ApiUrl', { Value: 'https://api.caps.naevatec.com' });
    api.hasOutput('ApiDomainTarget', { Value: { 'Fn::GetAtt': [Match.anyValue(), 'RegionalDomainName'] } });

    // CORS: app_origins + the web domain from config; the API no longer imports WebUrl (CDK's own table/bucket refs stay).
    expect(corsOrigins(api)).toEqual(['capacitor://localhost', 'https://caps.naevatec.com']);
    expect(JSON.stringify(api.toJSON())).not.toContain('cap-naeva-dev-data-WebUrl');

    // The certificate ARNs never reach a Lambda: no function environment references their parameters.
    const certRefs = ssmParams(api, CERT_PARAMS);
    for (const fn of Object.values(api.findResources('AWS::Lambda::Function'))) {
      const env = JSON.stringify((fn.Properties as { Environment?: unknown }).Environment ?? {});
      for (const id of certRefs) expect(env).not.toContain(id);
    }
  });

  it('[T-infra-025] without domains: no alias, certificate, API domain or mapping; CORS imports WebUrl; default URLs', () => {
    const { data, api } = synth();

    // The certificate parameters are still created (so they can be filled before domains are turned on) but unread.
    for (const name of CERT_PARAMS) data.hasResourceProperties('AWS::SSM::Parameter', { Name: name });
    expect(ssmParams(data, CERT_PARAMS)).toEqual([]);
    expect(ssmParams(api, CERT_PARAMS)).toEqual([]);

    const dist = Object.values(data.findResources('AWS::CloudFront::Distribution'))[0];
    const distConfig = (dist?.Properties as { DistributionConfig: Record<string, unknown> }).DistributionConfig;
    expect(distConfig.Aliases).toBeUndefined();
    expect(distConfig.ViewerCertificate).toBeUndefined();
    data.hasOutput('WebUrl', {
      Value: { 'Fn::Join': ['', ['https://', { 'Fn::GetAtt': [Match.anyValue(), 'DomainName'] }]] },
    });
    expect(Object.keys(data.findOutputs('WebDomainTarget'))).toEqual([]);

    api.resourceCountIs('AWS::ApiGatewayV2::DomainName', 0);
    api.resourceCountIs('AWS::ApiGatewayV2::ApiMapping', 0);
    expect(corsOrigins(api)).toEqual(['capacitor://localhost', { 'Fn::ImportValue': 'cap-naeva-dev-data-WebUrl' }]);
    api.hasOutput('ApiUrl', { Value: { 'Fn::GetAtt': [Match.anyValue(), 'ApiEndpoint'] } });
    expect(Object.keys(api.findOutputs('ApiDomainTarget'))).toEqual([]);

    // `--context domains=off` (first rollout, README § Custom domains) synthesises exactly this, even with domains.
    const off = synth({ domains: DOMAINS, context: { domains: 'off' } });
    off.api.resourceCountIs('AWS::ApiGatewayV2::DomainName', 0);
    expect(corsOrigins(off.api)).toEqual(corsOrigins(api));
    expect(ssmParams(off.data, CERT_PARAMS)).toEqual([]);
  });

  it('[T-infra-026] config: domains needs both web and api as bare host names; the domains switch is on|off only', () => {
    const load = (extra: Record<string, unknown>) =>
      loadInstallationConfig(deployment, configDir({ ...BASE, ...extra }));

    expect(load({}).domains).toBeUndefined();
    expect(load({ domains: DOMAINS }).domains).toEqual(DOMAINS);
    for (const bad of [
      { web: 'caps.naevatec.com' },
      { api: 'api.caps.naevatec.com' },
      { web: 'https://caps.naevatec.com', api: 'api.caps.naevatec.com' },
      { web: 'caps.naevatec.com/', api: 'api.caps.naevatec.com' },
      { web: 'Caps.Naevatec.com', api: 'api.caps.naevatec.com' },
      { web: 'localhost', api: 'api.caps.naevatec.com' },
      { web: 'caps.naevatec.com', api: 42 },
      'caps.naevatec.com',
      null,
    ]) {
      expect(() => load({ domains: bad })).toThrow(/"domains\.(web|api)" must be a bare host name/);
    }

    // The committed naeva.dev target declares the production hosts (story CAP-29).
    expect(loadInstallationConfig(deployment).domains).toEqual(DOMAINS);

    const config: InstallationConfig = { ...BASE, domains: DOMAINS };
    const withContext = (domains?: string) => new App({ context: domains === undefined ? {} : { domains } });
    expect(applyDomainsSwitch(withContext(), config)).toBe(config);
    expect(applyDomainsSwitch(withContext('on'), config)).toBe(config);
    expect(applyDomainsSwitch(withContext('off'), config)).toEqual(BASE);
    expect(() => applyDomainsSwitch(withContext('false'), config)).toThrow(/Invalid context domains="false"/);
  });
});
