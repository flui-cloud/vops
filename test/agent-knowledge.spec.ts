import { KnowledgeService } from '../src/agent-kit/knowledge.service';

describe('agent knowledge service', () => {
  const knowledge = new KnowledgeService();

  it('publishes an explicit manifest and searches it', () => {
    expect(knowledge.list()).toContain('skills/vops-deploy/references/operation-lifecycle.md');
    expect(knowledge.search('immutable approval')[0].path).toMatch(/operation-lifecycle|product-model/);
  });

  it('refuses traversal and unpublished files', () => {
    expect(() => knowledge.read('../../package.json')).toThrow(/not published/);
    expect(() => knowledge.read('manifest.json')).toThrow(/not published/);
  });
});
