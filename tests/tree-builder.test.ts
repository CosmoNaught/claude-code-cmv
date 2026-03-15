import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockIndex = { value: { version: '1.0.0', snapshots: {} as Record<string, any> } };

vi.mock('../src/core/metadata-store.js', () => ({
  readIndex: vi.fn(async () => mockIndex.value),
}));

vi.mock('chalk', () => {
  const passthrough = (s: string) => s;
  const chalk: any = passthrough;
  chalk.bold = Object.assign(passthrough, { cyan: passthrough });
  chalk.green = passthrough;
  chalk.dim = passthrough;
  return { default: chalk };
});

vi.mock('../src/utils/display.js', () => ({
  formatRelativeTime: (s: string) => 'recently',
}));

import { buildTree, renderTree, treeToJson } from '../src/core/tree-builder.js';

function makeSnapshot(name: string, overrides: Record<string, any> = {}) {
  return {
    id: overrides.id ?? `id-${name}`,
    name,
    description: overrides.description ?? '',
    created_at: overrides.created_at ?? '2025-01-01T00:00:00Z',
    source_session_id: overrides.source_session_id ?? 'sess-1',
    source_project_path: overrides.source_project_path ?? '/project',
    snapshot_dir: overrides.snapshot_dir ?? `/snapshots/${name}`,
    message_count: overrides.message_count ?? 10,
    estimated_tokens: overrides.estimated_tokens ?? 5000,
    tags: overrides.tags ?? [],
    parent_snapshot: overrides.parent_snapshot ?? undefined,
    session_active_at_capture: overrides.session_active_at_capture ?? undefined,
    branches: overrides.branches ?? [],
  };
}

beforeEach(() => {
  mockIndex.value = { version: '1.0.0', snapshots: {} };
});

describe('buildTree', () => {
  it('returns empty array when index has no snapshots', async () => {
    const roots = await buildTree();
    expect(roots).toEqual([]);
  });

  it('returns root snapshots (no parent_snapshot)', async () => {
    mockIndex.value.snapshots = {
      alpha: makeSnapshot('alpha'),
      beta: makeSnapshot('beta', { created_at: '2025-01-02T00:00:00Z' }),
    };

    const roots = await buildTree();
    expect(roots).toHaveLength(2);
    expect(roots[0]!.name).toBe('alpha');
    expect(roots[1]!.name).toBe('beta');
    expect(roots.every((r) => r.type === 'snapshot')).toBe(true);
  });

  it('sorts roots by created_at ascending', async () => {
    mockIndex.value.snapshots = {
      later: makeSnapshot('later', { created_at: '2025-06-01T00:00:00Z' }),
      earlier: makeSnapshot('earlier', { created_at: '2025-01-01T00:00:00Z' }),
      middle: makeSnapshot('middle', { created_at: '2025-03-01T00:00:00Z' }),
    };

    const roots = await buildTree();
    expect(roots.map((r) => r.name)).toEqual(['earlier', 'middle', 'later']);
  });

  it('builds parent-child hierarchy for snapshots', async () => {
    mockIndex.value.snapshots = {
      parent: makeSnapshot('parent'),
      child: makeSnapshot('child', { parent_snapshot: 'parent', created_at: '2025-01-02T00:00:00Z' }),
    };

    const roots = await buildTree();
    expect(roots).toHaveLength(1);
    expect(roots[0]!.name).toBe('parent');
    expect(roots[0]!.children.some((c) => c.type === 'snapshot' && c.name === 'child')).toBe(true);
  });

  it('attaches branches as children of their snapshot', async () => {
    mockIndex.value.snapshots = {
      snap1: makeSnapshot('snap1', {
        branches: [
          { name: 'branch-a', forked_session_id: 'fork-1', created_at: '2025-01-03T00:00:00Z' },
          { name: 'branch-b', forked_session_id: 'fork-2', created_at: '2025-01-04T00:00:00Z' },
        ],
      }),
    };

    const roots = await buildTree();
    expect(roots).toHaveLength(1);
    const snap = roots[0]!;
    const branchChildren = snap.children.filter((c) => c.type === 'branch');
    expect(branchChildren).toHaveLength(2);
    expect(branchChildren[0]!.name).toBe('branch-a');
    expect(branchChildren[0]!.branch).toBeDefined();
    expect(branchChildren[1]!.name).toBe('branch-b');
  });

  it('treats snapshot with non-existent parent as root', async () => {
    mockIndex.value.snapshots = {
      orphan: makeSnapshot('orphan', { parent_snapshot: 'does-not-exist' }),
    };

    const roots = await buildTree();
    expect(roots).toHaveLength(1);
    expect(roots[0]!.name).toBe('orphan');
  });
});

describe('renderTree', () => {
  it('returns message for empty roots', () => {
    expect(renderTree([])).toBe('No snapshots found.');
  });

  it('renders single root with branch children using ASCII connectors', async () => {
    mockIndex.value.snapshots = {
      root: makeSnapshot('root', {
        message_count: 5,
        branches: [{ name: 'b1', forked_session_id: 'f1', created_at: '2025-01-02T00:00:00Z' }],
      }),
    };

    const roots = await buildTree();
    const output = renderTree(roots);

    // Root line should contain the snapshot name and metadata
    expect(output).toContain('root');
    expect(output).toContain('snapshot');
    expect(output).toContain('5 msgs');
    // Branch child should use a connector
    expect(output).toContain('└── b1');
    expect(output).toContain('branch');
  });

  it('respects maxDepth and hides deeper nodes', async () => {
    mockIndex.value.snapshots = {
      grandparent: makeSnapshot('grandparent'),
      parent: makeSnapshot('parent', { parent_snapshot: 'grandparent', created_at: '2025-01-02T00:00:00Z' }),
      child: makeSnapshot('child', { parent_snapshot: 'parent', created_at: '2025-01-03T00:00:00Z' }),
    };

    const roots = await buildTree();

    const shallow = renderTree(roots, 1);
    expect(shallow).toContain('grandparent');
    expect(shallow).toContain('parent');
    expect(shallow).not.toContain('child');

    const full = renderTree(roots);
    expect(full).toContain('child');
  });
});

describe('treeToJson', () => {
  it('serializes tree with type, name, id, and nested children', async () => {
    mockIndex.value.snapshots = {
      root: makeSnapshot('root', {
        id: 'root-id',
        tags: ['important'],
        message_count: 12,
        created_at: '2025-05-01T00:00:00Z',
        branches: [{ name: 'dev', forked_session_id: 'fork-dev', created_at: '2025-05-02T00:00:00Z' }],
      }),
      child: makeSnapshot('child', {
        id: 'child-id',
        parent_snapshot: 'root',
        created_at: '2025-05-03T00:00:00Z',
      }),
    };

    const roots = await buildTree();
    const json = treeToJson(roots);

    expect(json).toHaveLength(1);
    const rootObj = json[0] as any;
    expect(rootObj.type).toBe('snapshot');
    expect(rootObj.name).toBe('root');
    expect(rootObj.id).toBe('root-id');
    expect(rootObj.created_at).toBe('2025-05-01T00:00:00Z');
    expect(rootObj.message_count).toBe(12);
    expect(rootObj.tags).toEqual(['important']);

    // Should have branch and child snapshot as children
    expect(rootObj.children).toHaveLength(2);

    const branchChild = rootObj.children.find((c: any) => c.type === 'branch');
    expect(branchChild).toBeDefined();
    expect(branchChild.name).toBe('dev');
    expect(branchChild.forked_session_id).toBe('fork-dev');
    expect(branchChild.created_at).toBe('2025-05-02T00:00:00Z');

    const snapChild = rootObj.children.find((c: any) => c.type === 'snapshot');
    expect(snapChild).toBeDefined();
    expect(snapChild.name).toBe('child');
    expect(snapChild.id).toBe('child-id');
  });

  it('omits children key when node has no children', async () => {
    mockIndex.value.snapshots = {
      leaf: makeSnapshot('leaf'),
    };

    const roots = await buildTree();
    const json = treeToJson(roots);
    const leafObj = json[0] as any;
    expect(leafObj.children).toBeUndefined();
  });
});
