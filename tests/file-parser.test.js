import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { strToU8, zipSync } from 'fflate';
import { parsePdfWithExpert } from '../src/server/file-parser.js';

const settings = {
  rag: { parserBaseUrl: 'https://expert.test/v4', parserApiKey: 'test-key' },
};

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(payload),
  };
}

function zipResponse(files) {
  const zip = zipSync(Object.fromEntries(
    Object.entries(files).map(([name, value]) => [name, typeof value === 'string' ? strToU8(value) : value]),
  ));
  return {
    ok: true,
    status: 200,
    arrayBuffer: async () => zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength),
  };
}

async function withDirectory(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'paper-reader-expert-'));
  try {
    return await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function mockFetch(implementation) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url, init });
    return implementation(url, init, calls);
  };
  return {
    calls,
    restore: () => { globalThis.fetch = original; },
  };
}

test('uploads, polls, downloads without forwarding auth, and persists Expert output', async () => {
  await withDirectory(async (directory) => {
    const zip = zipResponse({ 'result.md': '# Parsed', 'images/figure.jpg': new Uint8Array([1, 2, 3]) });
    const fetchMock = mockFetch((url, init, calls) => {
      if (calls.length === 1) {
        assert.equal(url, 'https://expert.test/v4/files/parser/create');
        assert.equal(init.method, 'POST');
        assert.equal(init.headers.Authorization, 'Bearer test-key');
        assert.ok(init.body instanceof FormData);
        return jsonResponse({ task_id: 'task-1', request_id: 'req-1' });
      }
      if (calls.length === 2) return jsonResponse({ status: 'processing', parsing_result_url: 'https://signed.test/ignored' });
      if (calls.length === 3) return jsonResponse({ status: 'succeeded', parsing_result_url: 'https://signed.test/result' });
      assert.equal(url, 'https://signed.test/result');
      assert.equal(init.headers, undefined);
      return zip;
    });
    try {
      const result = await parsePdfWithExpert(Buffer.from('%PDF'), directory, settings, undefined, {
        pollIntervalMs: 0,
        timeoutMs: 1000,
      });
      assert.deepEqual(result, {
        markdown: '# Parsed',
        taskId: 'task-1',
        images: [{ path: 'parsed/images/figure.jpg' }],
      });
      assert.equal(await readFile(path.join(directory, 'parsed/result.md'), 'utf8'), '# Parsed');
      assert.deepEqual(await readFile(path.join(directory, 'parsed/images/figure.jpg')), Buffer.from([1, 2, 3]));
      assert.deepEqual(JSON.parse(await readFile(path.join(directory, 'parse-task.json'), 'utf8')), {
        task_id: 'task-1',
        create: { task_id: 'task-1', request_id: 'req-1' },
        result: { status: 'succeeded' },
        status: 'succeeded',
      });
    } finally {
      fetchMock.restore();
    }
  });
});

test('reports Expert HTTP failures and invalid task responses', async () => {
  await withDirectory(async (directory) => {
    const fetchMock = mockFetch(() => jsonResponse({ error: { message: 'bad request' } }, 400));
    try {
      await assert.rejects(
        parsePdfWithExpert(Buffer.from('pdf'), directory, settings),
        /智谱 Expert.*HTTP 400.*bad request/,
      );
    } finally {
      fetchMock.restore();
    }
  });

  await withDirectory(async (directory) => {
    const fetchMock = mockFetch(() => jsonResponse({ request_id: 'without-task-id' }));
    try {
      await assert.rejects(parsePdfWithExpert(Buffer.from('pdf'), directory, settings), /缺少 task_id/);
    } finally {
      fetchMock.restore();
    }
  });
});

test('rejects a failed Expert task status', async () => {
  await withDirectory(async (directory) => {
    const fetchMock = mockFetch((url, init, calls) => {
      if (calls.length === 1) return jsonResponse({ task_id: 'task-failed' });
      return jsonResponse({ status: 'failed', error: { message: 'parse failed' } });
    });
    try {
      await assert.rejects(
        parsePdfWithExpert(Buffer.from('pdf'), directory, settings, undefined, { pollIntervalMs: 0 }),
        /智谱 Expert.*解析任务失败.*failed/,
      );
    } finally {
      fetchMock.restore();
    }
  });
});

test('rejects unsafe ZIP paths', async () => {
  await withDirectory(async (directory) => {
    const archive = zipResponse({ 'result.md': 'ok', '../outside.jpg': 'bad' });
    const fetchMock = mockFetch((url, init, calls) => {
      if (calls.length === 1) return jsonResponse({ task_id: 'task-traversal' });
      if (calls.length === 2) return jsonResponse({ status: 'succeeded', parsing_result_url: 'https://signed.test/result' });
      return archive;
    });
    try {
      await assert.rejects(
        parsePdfWithExpert(Buffer.from('pdf'), directory, settings, undefined, { pollIntervalMs: 0 }),
        /ZIP 包包含不安全路径/,
      );
    } finally {
      fetchMock.restore();
    }
  });
});

test('rejects missing or empty result.md', async () => {
  await withDirectory(async (directory) => {
    const archive = zipResponse({ 'images/figure.jpg': 'image' });
    const fetchMock = mockFetch((url, init, calls) => {
      if (calls.length === 1) return jsonResponse({ task_id: 'task-no-md' });
      if (calls.length === 2) return jsonResponse({ status: 'succeeded', parsing_result_url: 'https://signed.test/result' });
      return archive;
    });
    try {
      await assert.rejects(
        parsePdfWithExpert(Buffer.from('pdf'), directory, settings, undefined, { pollIntervalMs: 0 }),
        /缺少非空 result.md/,
      );
    } finally {
      fetchMock.restore();
    }
  });
});

test('fails before upload when the parser key is missing', async () => {
  await withDirectory(async (directory) => {
    const originalKey = process.env.GLM_API_KEY;
    delete process.env.GLM_API_KEY;
    const fetchMock = mockFetch(() => { throw new Error('must not call fetch'); });
    try {
      await assert.rejects(
        parsePdfWithExpert(Buffer.from('pdf'), directory, { rag: { parserBaseUrl: 'https://expert.test' } }),
        /未配置 parser API key/,
      );
      assert.equal(fetchMock.calls.length, 0);
    } finally {
      if (originalKey === undefined) delete process.env.GLM_API_KEY;
      else process.env.GLM_API_KEY = originalKey;
      fetchMock.restore();
    }
  });
});
