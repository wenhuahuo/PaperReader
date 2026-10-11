import { Type } from '@earendil-works/pi-ai';
import { defineTool } from '@earendil-works/pi-coding-agent';
import { retrievePaperSections } from './rag.js';

const paperSearchTool = defineTool({
  name: 'paper_search',
  label: 'Paper Search',
  description: '检索当前论文按小节建立的全文索引。用户要求结合全文、跨章节比较、概括全文，或当前页信息不足时使用。',
  parameters: Type.Object({
    query: Type.String({ description: '用于检索论文全文的自然语言问题' }),
    topK: Type.Optional(Type.Integer({ minimum: 1, maximum: 8, description: '返回的小节数量，省略时使用应用配置' })),
  }),

  async execute(_toolCallId, params, signal) {
    const paperId = process.env.PAPER_READER_RAG_PAPER_ID;
    if (!paperId) throw new Error('全文检索工具缺少当前论文 ID');
    const results = await retrievePaperSections(paperId, params.query, params.topK, signal);
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          results: results.map((result) => ({
            section: result.title,
            pages: result.pageStart == null
              ? '未知'
              : result.pageStart === result.pageEnd
                ? `${result.pageStart}`
                : `${result.pageStart}-${result.pageEnd}`,
            score: Number(result.score.toFixed(4)),
            content: result.text,
          })),
        }, null, 2),
      }],
      details: { results },
    };
  },
});

export default function registerPaperSearchTool(pi) {
  pi.registerTool(paperSearchTool);
}
