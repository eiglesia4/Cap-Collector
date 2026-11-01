// Web build over HTTPS (CAP-16): CloudFront + OAC in front of the private web bucket, SPA fallback, deploy:web.
import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';

import { CollectorsDataStack, SPA_FALLBACK_STATUSES } from '../lib/collectors-data-stack.js';
import { type Command, deployWeb, readWebOutputs, webTarget } from '../lib/web-deploy.js';

const dataTemplate = () =>
  Template.fromStack(
    new CollectorsDataStack(new App(), 'CollectorsData', {
      deployment: { installation: 'naeva', stage: 'dev' },
      config: { config_version: 'test', region: 'test-region-1', app_origins: ['capacitor://localhost'] },
    }),
  );

type Resources = Record<string, { Type: string; Properties: Record<string, unknown> }>;

describe('web distribution', () => {
  it('[T-infra-019] snapshot: CloudFront with OAC over a private bucket, HTTPS redirect, SPA error responses', () => {
    const template = dataTemplate();
    template.resourceCountIs('AWS::CloudFront::Distribution', 1);
    template.resourceCountIs('AWS::CloudFront::OriginAccessControl', 1);
    template.hasResourceProperties('AWS::CloudFront::OriginAccessControl', {
      OriginAccessControlConfig: Match.objectLike({ OriginAccessControlOriginType: 's3', SigningBehavior: 'always' }),
    });

    const res = template.toJSON().Resources as Resources;
    const [dist] = Object.values(res).filter((r) => r.Type === 'AWS::CloudFront::Distribution');
    const config = dist?.Properties.DistributionConfig as Record<string, unknown>;
    // The snapshot pins the behaviour that matters; origin ids and domain tokens are hashes, so they are left out.
    const { Origins: origins, DefaultCacheBehavior: behavior, ...rest } = config;
    const { TargetOriginId: _target, ...behaviorRest } = behavior as Record<string, unknown>;
    expect({
      ...rest,
      DefaultCacheBehavior: behaviorRest,
      originCount: (origins as unknown[]).length,
    }).toMatchSnapshot();
    expect(config.CustomErrorResponses).toEqual(
      SPA_FALLBACK_STATUSES.map((code) => ({
        ErrorCode: code,
        ResponseCode: 200,
        ResponsePagePath: '/index.html',
        ErrorCachingMinTTL: 0,
      })),
    );
    expect(behaviorRest).toMatchObject({ ViewerProtocolPolicy: 'redirect-to-https', Compress: true });
    expect(rest).toMatchObject({ DefaultRootObject: 'index.html', PriceClass: 'PriceClass_100', Enabled: true });

    // Web bucket: private, readable only by this distribution (OAC policy with the distribution ARN as condition).
    template.hasResourceProperties('AWS::S3::BucketPolicy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: 'Allow',
            Principal: { Service: 'cloudfront.amazonaws.com' },
            Action: 's3:GetObject',
            Condition: { StringEquals: { 'AWS:SourceArn': Match.anyValue() } },
          }),
        ]),
      },
    });
    // No statement allows anonymous access (the TLS-only Deny uses `AWS: *` legitimately).
    type Statement = { Effect: string; Principal?: unknown };
    const statements = Object.values(res)
      .filter((r) => r.Type === 'AWS::S3::BucketPolicy')
      .flatMap((r) => (r.Properties.PolicyDocument as { Statement: Statement[] }).Statement);
    const isEveryone = (p: unknown) => p === '*' || JSON.stringify(p) === '{"AWS":"*"}';
    expect(statements.filter((st) => st.Effect === 'Allow' && isEveryone(st.Principal))).toEqual([]);

    // The images bucket CORS allows the CloudFront origin instead of the old website endpoint.
    const images = Object.values(res).find((r) => r.Type === 'AWS::S3::Bucket' && r.Properties.CorsConfiguration);
    const origins2 = JSON.stringify((images?.Properties.CorsConfiguration as { CorsRules: unknown[] }).CorsRules);
    expect(origins2).toContain('https://');
    expect(origins2).toContain('DomainName');
    expect(origins2).not.toContain('WebsiteURL');
    template.hasOutput('WebUrl', { Export: { Name: 'cap-naeva-dev-data-WebUrl' } });
  });

  it('[T-infra-020] deploy:web resolves bucket and distribution from stack outputs, dry-run runs nothing, refuses without CAP_STAGE', () => {
    const calls: Command[] = [];
    const describe = JSON.stringify({
      Stacks: [
        {
          Outputs: [
            { OutputKey: 'WebBucketName', OutputValue: 'cap-web-bucket' },
            { OutputKey: 'DistributionId', OutputValue: 'E123EXAMPLE' },
            { OutputKey: 'WebUrl', OutputValue: 'https://d111.cloudfront.net' },
          ],
        },
      ],
    });
    const run = (c: Command) => {
      calls.push(c);
      return c.args[0] === 'cloudformation' ? describe : '';
    };
    const env = { CAP_INSTALLATION: 'naeva', CAP_STAGE: 'dev' };

    const dry = deployWeb({ env, run, dryRun: true });
    expect(dry.target).toMatchObject({ stackName: 'cap-naeva-dev-data', region: 'eu-west-1' });
    expect(dry.outputs).toEqual({
      bucket: 'cap-web-bucket',
      distributionId: 'E123EXAMPLE',
      webUrl: 'https://d111.cloudfront.net',
    });
    // Only the read-only describe-stacks ran; the region comes from infra/config, never from code.
    expect(calls).toEqual([
      {
        cmd: 'aws',
        args: ['cloudformation', 'describe-stacks', '--stack-name', 'cap-naeva-dev-data', '--region', 'eu-west-1'],
      },
    ]);
    expect(dry.plan.map((c) => `${c.cmd} ${c.args.join(' ')}`)).toEqual([
      'npm run build:shared',
      'npm run build -w @capcollector/app',
      'aws s3 sync app/dist s3://cap-web-bucket --delete --region eu-west-1',
      'aws cloudfront create-invalidation --distribution-id E123EXAMPLE --paths /*',
    ]);

    // A real run executes the plan, in order, after the lookup.
    calls.length = 0;
    deployWeb({ env, run, dryRun: false });
    expect(calls.map((c) => c.args[0])).toEqual(['cloudformation', 'run', 'run', 's3', 'cloudfront']);

    // No stage (or installation) → refuses before any AWS call; unknown target → no config file.
    calls.length = 0;
    expect(() => deployWeb({ env: { CAP_INSTALLATION: 'naeva' }, run, dryRun: true })).toThrow(/Missing stage/);
    expect(() => webTarget({ CAP_STAGE: 'dev' })).toThrow(/Missing installation/);
    expect(() => webTarget({ CAP_INSTALLATION: 'naeva', CAP_STAGE: 'prod' })).toThrow(/No config for naeva\/prod/);
    expect(calls).toEqual([]);

    // A stack deployed before CAP-16 has no DistributionId: clear message.
    const old = () => JSON.stringify({ Stacks: [{ Outputs: [{ OutputKey: 'WebBucketName', OutputValue: 'b' }] }] });
    expect(() => readWebOutputs(webTarget(env), old)).toThrow(/has no output DistributionId/);
    expect(() => readWebOutputs(webTarget(env), () => '{}')).toThrow(/has no output WebBucketName/);
  });
});
