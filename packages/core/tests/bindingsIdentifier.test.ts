// The four identifier matchers (spec §3.8), tested against strings.
//
// Every test here is a FILE'S TEXT and an identifier, with no temp tree and no
// filesystem, because that is the point of the pure/IO split: the patterns can
// be pinned down exhaustively — including the near misses — at the cost of one
// string literal each. The walk that finds these files is tested against a real
// tree in bindingsResolve.test.ts.
//
// Half of the tests below are NEGATIVE, and they are the ones that matter. A
// bare substring match would pass every positive test in this file and would
// report a citation `ok` because the identifier appears in a comment. That is
// the exact lie provenance exists to prevent, so each matcher is held to: the
// identifier in a comment, in a string literal, as a substring of a longer
// name, and — for k8s — split across two documents.

import { describe, expect, it } from 'vitest';
import {
  candidateDescription,
  composeDefines,
  definesIdentifier,
  identifierRefProblem,
  isCandidateFilename,
  k8sDefines,
  packageDefines,
  terraformDefines,
} from '../src/index.js';

// ---------------------------------------------------------------------------
// Which files are even looked in
// ---------------------------------------------------------------------------

describe('isCandidateFilename', () => {
  it('matches the files each source can live in, and no others', () => {
    expect(isCandidateFilename('terraform', 'main.tf')).toBe(true);
    expect(isCandidateFilename('terraform', 'MAIN.TF')).toBe(true);
    expect(isCandidateFilename('compose', 'docker-compose.yml')).toBe(true);
    expect(isCandidateFilename('compose', 'docker-compose.prod.yaml')).toBe(true);
    expect(isCandidateFilename('compose', 'compose.yaml')).toBe(true);
    expect(isCandidateFilename('package', 'package.json')).toBe(true);
    expect(isCandidateFilename('k8s-manifest', 'deploy.yaml')).toBe(true);
    expect(isCandidateFilename('k8s-manifest', 'deploy.yml')).toBe(true);
  });

  it('deliberately excludes the near neighbours', () => {
    // *.tf.json is Terraform's JSON syntax — a different grammar, so the HCL
    // patterns would be guessing. *.tfvars holds values, not declarations.
    expect(isCandidateFilename('terraform', 'main.tf.json')).toBe(false);
    expect(isCandidateFilename('terraform', 'terraform.tfvars')).toBe(false);
    // A compose file is named for compose. A k8s manifest happens to be YAML,
    // and IS searched for k8s — but not for compose services.
    expect(isCandidateFilename('compose', 'deploy.yaml')).toBe(false);
    expect(isCandidateFilename('compose', 'docker-compose.json')).toBe(false);
    // package-lock.json is not a package declaration.
    expect(isCandidateFilename('package', 'package-lock.json')).toBe(false);
    expect(isCandidateFilename('package', 'my-package.json')).toBe(false);
    expect(isCandidateFilename('k8s-manifest', 'values.yaml.tpl')).toBe(false);
  });

  it('describes the kind it looked for, for the missing line', () => {
    expect(candidateDescription('terraform')).toBe('*.tf');
    expect(candidateDescription('package')).toBe('package.json');
  });
});

// ---------------------------------------------------------------------------
// terraform
// ---------------------------------------------------------------------------

describe('terraformDefines', () => {
  const tf = [
    '# resource "aws_ecs_service" "ghost" {}',
    'variable "region" {',
    '  default = "eu-west-1"',
    '}',
    '',
    'resource   "aws_ecs_service"   "orders" {',
    '  name = "orders"',
    '}',
    '',
    'resource "aws_ecs_service" "orders_legacy" {}',
    'module "network" {',
    '  source = "./network"',
    '}',
    'data "aws_ami" "ubuntu" {',
    '}',
    'output "url" {',
    '  value = "https://x"',
    '}',
  ].join('\n');

  it('matches the resource form, with any whitespace between the tokens', () => {
    expect(terraformDefines(tf, 'aws_ecs_service.orders')).toEqual({
      verdict: 'defines',
      line: 6,
    });
  });

  it('matches the module, data, variable and output forms', () => {
    expect(terraformDefines(tf, 'module.network')).toEqual({ verdict: 'defines', line: 11 });
    expect(terraformDefines(tf, 'data.aws_ami.ubuntu')).toEqual({
      verdict: 'defines',
      line: 14,
    });
    expect(terraformDefines(tf, 'var.region')).toEqual({ verdict: 'defines', line: 2 });
    expect(terraformDefines(tf, 'output.url')).toEqual({ verdict: 'defines', line: 16 });
    // `module.network.subnet_id` reads an output of the module; the module
    // block is still the declaration the ref points into.
    expect(terraformDefines(tf, 'module.network.subnet_id').verdict).toBe('defines');
    // An attribute reference on a resource resolves to the resource.
    expect(terraformDefines(tf, 'aws_ecs_service.orders.id').verdict).toBe('defines');
  });

  it('does not match a longer name that starts with the cited one', () => {
    // The exact false positive a substring match makes: `orders_legacy` is a
    // different resource, and the closing quote is what keeps them apart.
    expect(terraformDefines('resource "aws_ecs_service" "orders_legacy" {}', 'aws_ecs_service.orders')).toEqual({
      verdict: 'absent',
    });
    expect(terraformDefines(tf, 'aws_ecs_service.order')).toEqual({ verdict: 'absent' });
  });

  it('does not match a comment, a string literal, or a use', () => {
    expect(terraformDefines(tf, 'aws_ecs_service.ghost')).toEqual({ verdict: 'absent' });
    for (const text of [
      '// resource "aws_ecs_service" "orders" {}',
      '  # resource "aws_ecs_service" "orders" {',
      'description = "see resource \\"aws_ecs_service\\" \\"orders\\""',
      'depends_on = [aws_ecs_service.orders]',
      'output "x" { value = aws_ecs_service.orders.id }',
      'This README describes resource aws_ecs_service.orders in prose.',
    ]) {
      expect(terraformDefines(text, 'aws_ecs_service.orders'), text).toEqual({
        verdict: 'absent',
      });
    }
  });

  it('does not confuse a data source with a resource of the same name', () => {
    const text = 'data "aws_ecs_service" "orders" {}\n';
    expect(terraformDefines(text, 'aws_ecs_service.orders')).toEqual({ verdict: 'absent' });
    expect(terraformDefines(text, 'data.aws_ecs_service.orders').verdict).toBe('defines');
  });

  it('does not match a resource block that has been commented OUT with /* */', () => {
    // The realistic false `ok`, and the one the docstring used to claim was
    // excluded: commenting a block out with `/* */` while leaving it in the
    // file is ordinary Terraform practice, and the line-start anchor does not
    // see it, because the commented lines still begin at column 0. Certifying
    // a citation to infrastructure that was deliberately DISABLED is exactly
    // the lie provenance exists to prevent.
    expect(
      terraformDefines('/*\nresource "aws_ecs_service" "orders" {\n}\n*/\n', 'aws_ecs_service.orders'),
    ).toEqual({ verdict: 'absent' });
    // Same block, still live below the comment: the strip must not eat code.
    expect(
      terraformDefines(
        '/*\nresource "aws_ecs_service" "orders" {}\n*/\nresource "aws_ecs_service" "orders" {}\n',
        'aws_ecs_service.orders',
      ),
    ).toEqual({ verdict: 'defines', line: 4 });
    // A `/*` inside a string is not a comment.
    expect(
      terraformDefines('resource "aws_ecs_service" "orders" {\n  x = "/*"\n}\n', 'aws_ecs_service.orders'),
    ).toEqual({ verdict: 'defines', line: 1 });
    expect(terraformDefines('/*\nresource "aws_ecs_service" "orders" {}\n', 'aws_ecs_service.orders')).toEqual({
      verdict: 'unchecked',
      reason: 'an unterminated /* block comment — not readable as HCL',
    });
  });

  it('does not read a heredoc body as HCL', () => {
    // Heredoc content is string DATA: an embedded template, a doc string or a
    // local-exec script that writes a .tf file. A resource header in one is a
    // quoted string, not a declaration.
    const embedded =
      'resource "null_resource" "d" {\n  triggers = {\n    doc = <<EOT\nresource "aws_ecs_service" "orders" {}\nEOT\n  }\n}\n';
    expect(terraformDefines(embedded, 'aws_ecs_service.orders')).toEqual({ verdict: 'absent' });
    expect(terraformDefines(embedded, 'null_resource.d')).toEqual({ verdict: 'defines', line: 1 });
    // The indented form terminates on an indented terminator.
    expect(
      terraformDefines(
        'resource "aws_instance" "a" {\n  user_data = <<-EOT\nresource "aws_ecs_service" "orders" {\n  EOT\n}\nresource "aws_ecs_service" "orders" {}\n',
        'aws_ecs_service.orders',
      ),
    ).toEqual({ verdict: 'defines', line: 6 });
    expect(
      terraformDefines('x = <<EOT\nresource "aws_ecs_service" "orders" {}\n', 'aws_ecs_service.orders'),
    ).toEqual({ verdict: 'unchecked', reason: 'an unterminated <<EOT heredoc — not readable as HCL' });
  });

  it('resolves a local against its locals block, rather than shrugging', () => {
    // This used to be `unchecked`, which made a whole address family
    // agent-choosable and unfalsifiable: `terraform=local.anything` scored
    // outside precision's denominator and exited 0.
    expect(terraformDefines('locals {\n  orders = 1\n}\n', 'local.orders')).toEqual({
      verdict: 'defines',
      line: 2,
    });
    expect(terraformDefines('locals {\n  "orders" = 1\n}\n', 'local.orders').verdict).toBe('defines');
    // A USE of a local is not a declaration, and neither is a key nested
    // inside another local's value.
    expect(terraformDefines('locals {\n  a = local.orders\n}\n', 'local.orders')).toEqual({
      verdict: 'absent',
    });
    expect(terraformDefines('locals {\n  tags = {\n    orders = 1\n  }\n}\n', 'local.orders')).toEqual({
      verdict: 'absent',
    });
    // A locals block written on one line is the honest refusal.
    expect(terraformDefines('locals { orders = 1 }\n', 'local.orders').verdict).toBe('unchecked');
  });

  it('treats a ref that is not a terraform address as a defect in the REF, not in a file', () => {
    // Every one of these is decided by the string the agent wrote. Reporting
    // them `unchecked` put them outside precision's denominator and exited 0,
    // so an agent could invent citations at will and still score 1.0.
    for (const bad of ['orders', 'a.b.c.d', 'var.x.y', 'each.value', 'path.module', 'a..b']) {
      expect(identifierRefProblem('terraform', bad), bad).toBeTypeOf('string');
    }
    // A real address has no problem to report.
    for (const good of ['aws_ecs_service.orders', 'module.network', 'data.aws_ami.ubuntu', 'local.x']) {
      expect(identifierRefProblem('terraform', good), good).toBeUndefined();
    }
    expect(identifierRefProblem('compose', 'orders-api')).toBeUndefined();
    expect(identifierRefProblem('package', '@acme/orders')).toBeUndefined();
    expect(identifierRefProblem('k8s-manifest', 'Deployment/orders')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// line endings and byte-order marks — the false-`missing` side
// ---------------------------------------------------------------------------

describe('normalisation', () => {
  it('reads a CRLF file exactly as it reads the same file with LF', () => {
    // A Windows-authored manifest that plainly declares the cited resource was
    // reported `missing` and failed the build; the same compose file was
    // reported `unchecked` with the untrue reason "written in flow style".
    expect(k8sDefines('apiVersion: apps/v1\r\nkind: Deployment\r\nmetadata:\r\n  name: orders\r\n', 'Deployment/orders')).toEqual(
      { verdict: 'defines', line: 4 },
    );
    expect(composeDefines('services:\r\n  orders-api:\r\n    image: x\r\n', 'orders-api')).toEqual({
      verdict: 'defines',
      line: 2,
    });
    expect(terraformDefines('resource "aws_ecs_service" "orders" {\r\n}\r\n', 'aws_ecs_service.orders')).toEqual({
      verdict: 'defines',
      line: 1,
    });
    expect(packageDefines('{\r\n  "name": "@acme/orders"\r\n}\r\n', '@acme/orders')).toEqual({
      verdict: 'defines',
      line: 2,
    });
  });

  it('reads a file that starts with a byte-order mark', () => {
    expect(k8sDefines('\ufeffkind: Deployment\nmetadata:\n  name: orders\n', 'Deployment/orders')).toEqual({
      verdict: 'defines',
      line: 3,
    });
    // A BOM is legal in a file a Windows editor wrote; JSON.parse throws on it,
    // and the report said the file was "not valid JSON", which it is.
    expect(packageDefines('\ufeff{"name":"@acme/orders"}\n', '@acme/orders').verdict).toBe('defines');
    expect(composeDefines('\ufeffservices:\n  orders-api:\n    image: x\n', 'orders-api')).toEqual({
      verdict: 'defines',
      line: 2,
    });
  });

  it('accepts a quoted YAML key wherever it accepts a bare one', () => {
    // keyAtIndent took `"name":` and topLevelScalar did not, so the key test
    // passed, the value read came back undefined, and a correct citation was
    // reported as naming something else.
    expect(k8sDefines('kind: Deployment\nmetadata:\n  "name": orders\n', 'Deployment/orders').verdict).toBe(
      'defines',
    );
    expect(k8sDefines('"kind": Deployment\nmetadata:\n  name: orders\n', 'Deployment/orders').verdict).toBe(
      'defines',
    );
  });

  it('finds a service listed after a merge key, rather than bailing at it', () => {
    // A merge key can only ADD services, so a key found literally in the block
    // is a definition whatever the anchor contributes. Bailing made the verdict
    // depend on line order.
    expect(composeDefines('services:\n  <<: *base\n  orders-api:\n    image: x\n', 'orders-api')).toEqual({
      verdict: 'defines',
      line: 3,
    });
    // And when the key really is not there, the merge key is still the honest
    // reason we cannot say it is absent.
    expect(composeDefines('services:\n  <<: *base\n  other:\n    image: x\n', 'orders-api')).toEqual({
      verdict: 'unchecked',
      reason: 'the services block uses a YAML merge key — needs a YAML parser',
    });
  });
});

// ---------------------------------------------------------------------------
// compose
// ---------------------------------------------------------------------------

describe('composeDefines', () => {
  const compose = [
    'version: "3.9"',
    '',
    '# services: fake-api:',
    'services:',
    '  orders-api:',
    '    image: acme/orders',
    '    depends_on:',
    '      - billing-api',
    '    environment:',
    '      SERVICE: pretend-api',
    '  "quoted-api":',
    '    image: acme/quoted',
    '  volumes:',
    '    image: acme/a-service-actually-called-volumes',
    '',
    'volumes:',
    '  pgdata:',
    'networks:',
    '  default:',
  ].join('\n');

  it('matches a service key at the services indent', () => {
    expect(composeDefines(compose, 'orders-api')).toEqual({ verdict: 'defines', line: 5 });
    expect(composeDefines(compose, 'quoted-api')).toEqual({ verdict: 'defines', line: 11 });
  });

  it('matches a service that happens to be called volumes', () => {
    // The block ends at the next COLUMN-0 key, so a service whose name
    // collides with a top-level section is still found — and the top-level
    // `volumes:` mapping does not turn `pgdata` into a service.
    expect(composeDefines(compose, 'volumes')).toEqual({ verdict: 'defines', line: 13 });
    expect(composeDefines(compose, 'pgdata')).toEqual({ verdict: 'absent' });
    expect(composeDefines(compose, 'default')).toEqual({ verdict: 'absent' });
  });

  it('does not match anything nested inside a service', () => {
    // depends_on entries, image names and env values are all USES.
    expect(composeDefines(compose, 'billing-api')).toEqual({ verdict: 'absent' });
    expect(composeDefines(compose, 'image')).toEqual({ verdict: 'absent' });
    expect(composeDefines(compose, 'pretend-api')).toEqual({ verdict: 'absent' });
    expect(composeDefines(compose, 'depends_on')).toEqual({ verdict: 'absent' });
  });

  it('does not match a comment, or a substring of a service name', () => {
    expect(composeDefines(compose, 'fake-api')).toEqual({ verdict: 'absent' });
    expect(composeDefines(compose, 'orders')).toEqual({ verdict: 'absent' });
    expect(composeDefines(compose, 'orders-api-v2')).toEqual({ verdict: 'absent' });
  });

  it('does not read a nested services: key as the top-level one', () => {
    const nested = ['x-anchors:', '  services:', '    orders-api:', '      image: x'].join(
      '\n',
    );
    expect(composeDefines(nested, 'orders-api')).toEqual({ verdict: 'absent' });
  });

  it('is unchecked for the YAML this cannot read without a parser', () => {
    expect(composeDefines('services: {orders-api: {}}\n', 'orders-api')).toEqual({
      verdict: 'unchecked',
      reason: 'services is written in flow style — needs a YAML parser',
    });
    expect(
      composeDefines('services:\n  <<: *base\n  orders-api:\n    image: x\n', 'other'),
    ).toEqual({
      verdict: 'unchecked',
      reason: 'the services block uses a YAML merge key — needs a YAML parser',
    });
    expect(composeDefines('services:\n\torders-api:\n', 'orders-api').verdict).toBe(
      'unchecked',
    );
  });

  it('is absent, not unchecked, for a compose file with no services at all', () => {
    expect(composeDefines('version: "3"\nvolumes:\n  a:\n', 'orders-api')).toEqual({
      verdict: 'absent',
    });
  });
});

// ---------------------------------------------------------------------------
// package
// ---------------------------------------------------------------------------

describe('packageDefines', () => {
  const pkg = JSON.stringify(
    {
      name: '@acme/orders',
      version: '1.0.0',
      dependencies: { '@acme/billing': '^1.0.0' },
      workspaces: ['packages/*'],
    },
    null,
    2,
  );

  it('matches the name field exactly', () => {
    expect(packageDefines(pkg, '@acme/orders')).toEqual({ verdict: 'defines', line: 2 });
  });

  it('does not match a dependency of the same shape', () => {
    // The failure this exists to prevent: a package that DEPENDS on
    // @acme/billing is not @acme/billing, and verifying that citation would
    // credit the agent for a file it never opened.
    expect(packageDefines(pkg, '@acme/billing')).toEqual({ verdict: 'absent' });
  });

  it('does not match a prefix, a suffix, or a different case', () => {
    expect(packageDefines(pkg, '@acme/order')).toEqual({ verdict: 'absent' });
    expect(packageDefines(pkg, '@acme/orders-api')).toEqual({ verdict: 'absent' });
    expect(packageDefines(pkg, '@ACME/orders')).toEqual({ verdict: 'absent' });
    expect(packageDefines(pkg, 'orders')).toEqual({ verdict: 'absent' });
  });

  it('is unchecked when the file is not valid JSON', () => {
    // The name may well be declared in there; we cannot see it, and saying
    // "absent" would be an accusation we cannot support.
    expect(packageDefines('{ name: @acme/orders }', '@acme/orders')).toEqual({
      verdict: 'unchecked',
      reason: 'package.json is not valid JSON',
    });
  });

  it('is absent when there is no name field, or it is not a string', () => {
    expect(packageDefines('{"private": true}', '@acme/orders')).toEqual({ verdict: 'absent' });
    expect(packageDefines('{"name": 3}', '3')).toEqual({ verdict: 'absent' });
  });
});

// ---------------------------------------------------------------------------
// k8s-manifest
// ---------------------------------------------------------------------------

describe('k8sDefines', () => {
  const manifest = [
    'apiVersion: apps/v1',
    'kind: Deployment',
    'metadata:',
    '  name: orders',
    '  labels:',
    '    name: not-the-resource-name',
    'spec:',
    '  template:',
    '    metadata:',
    '      name: orders-pod',
    '---',
    'apiVersion: v1',
    'kind: Service',
    'metadata:',
    '  name: orders-svc',
  ].join('\n');

  it('matches a kind and name from the same document', () => {
    expect(k8sDefines(manifest, 'Deployment/orders')).toEqual({ verdict: 'defines', line: 4 });
    expect(k8sDefines(manifest, 'Service/orders-svc')).toEqual({
      verdict: 'defines',
      line: 15,
    });
  });

  it('never takes the kind from one document and the name from another', () => {
    // The likely false positive, and the reason documents are split first: a
    // Deployment and a Service sit in one file, so a per-file match would
    // report Service/orders and Deployment/orders-svc as both verified.
    expect(k8sDefines(manifest, 'Service/orders')).toEqual({ verdict: 'absent' });
    expect(k8sDefines(manifest, 'Deployment/orders-svc')).toEqual({ verdict: 'absent' });
    expect(k8sDefines(manifest, 'Ingress/orders')).toEqual({ verdict: 'absent' });
  });

  it('reads metadata.name, not every name: in the file', () => {
    // A label called `name`, and the pod template's own metadata.name, are
    // both `name: something` at some indent. Neither is this resource's name.
    expect(k8sDefines(manifest, 'Deployment/not-the-resource-name')).toEqual({
      verdict: 'absent',
    });
    expect(k8sDefines(manifest, 'Deployment/orders-pod')).toEqual({ verdict: 'absent' });
  });

  it('does not match a substring of a name', () => {
    expect(k8sDefines(manifest, 'Deployment/order')).toEqual({ verdict: 'absent' });
    expect(k8sDefines(manifest, 'Deployment/orders-api')).toEqual({ verdict: 'absent' });
  });

  it('matches a bare name against any document that declares it', () => {
    expect(k8sDefines(manifest, 'orders')).toEqual({ verdict: 'defines', line: 4 });
    expect(k8sDefines(manifest, 'nothing-here')).toEqual({ verdict: 'absent' });
  });

  it('is absent for a YAML file that is not a manifest at all', () => {
    expect(k8sDefines('a: 1\nb:\n  name: orders\n', 'orders')).toEqual({ verdict: 'absent' });
  });

  it('is unchecked for flow-style metadata, and lets other documents answer first', () => {
    expect(k8sDefines('kind: Deployment\nmetadata: {name: orders}\n', 'Deployment/orders')).toEqual(
      { verdict: 'unchecked', reason: 'metadata is written in flow style — needs a YAML parser' },
    );
    // One unreadable document does not stop a later one from verifying.
    const mixed = [
      'kind: Deployment',
      'metadata: {name: orders}',
      '---',
      'kind: Deployment',
      'metadata:',
      '  name: orders',
    ].join('\n');
    expect(k8sDefines(mixed, 'Deployment/orders')).toEqual({ verdict: 'defines', line: 6 });
  });

  it('handles quoted scalars and trailing comments', () => {
    const text = 'kind: "Deployment"  # the app\nmetadata:\n  name: \'orders\'\n';
    expect(k8sDefines(text, 'Deployment/orders')).toEqual({ verdict: 'defines', line: 3 });
  });
});

// ---------------------------------------------------------------------------
// The one entry point
// ---------------------------------------------------------------------------

describe('definesIdentifier', () => {
  it('routes each source to its own matcher', () => {
    expect(definesIdentifier('terraform', 'module "x" {}', 'module.x').verdict).toBe('defines');
    expect(definesIdentifier('compose', 'services:\n  a:\n', 'a').verdict).toBe('defines');
    expect(definesIdentifier('package', '{"name":"a"}', 'a').verdict).toBe('defines');
    expect(
      definesIdentifier('k8s-manifest', 'kind: Job\nmetadata:\n  name: a\n', 'Job/a').verdict,
    ).toBe('defines');
  });
});
