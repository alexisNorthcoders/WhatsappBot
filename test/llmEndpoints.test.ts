import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { agentEndpoint, agentLlmKeyError, deepInfraEndpoint } from '../models/models.ts';

describe('deepInfraEndpoint', () => {
  it('defaults to DeepInfra', () => {
    assert.deepEqual(deepInfraEndpoint({ DEEPINFRA_API_KEY: 'k' }), {
      baseURL: 'https://api.deepinfra.com/v1/openai',
      apiKey: 'k',
    });
  });

  it('uses DEEPINFRA_BASE_URL when set', () => {
    assert.deepEqual(deepInfraEndpoint({ DEEPINFRA_BASE_URL: ' http://minipc.local:8080/v1 ', DEEPINFRA_API_KEY: 'k' }), {
      baseURL: 'http://minipc.local:8080/v1',
      apiKey: 'k',
    });
  });
});

describe('agentEndpoint', () => {
  it('defaults to OpenAI with OPENAI_API_KEY', () => {
    assert.deepEqual(agentEndpoint({ OPENAI_API_KEY: 'sk' }), { apiKey: 'sk' });
  });

  it('uses AGENT_LLM_BASE_URL with its own key, not the OpenAI one', () => {
    assert.deepEqual(
      agentEndpoint({ AGENT_LLM_BASE_URL: 'http://minipc.local:8080/v1', AGENT_LLM_API_KEY: 'local', OPENAI_API_KEY: 'sk' }),
      { baseURL: 'http://minipc.local:8080/v1', apiKey: 'local' },
    );
  });

  it('ignores a blank AGENT_LLM_BASE_URL', () => {
    assert.deepEqual(agentEndpoint({ AGENT_LLM_BASE_URL: '  ', OPENAI_API_KEY: 'sk' }), { apiKey: 'sk' });
  });
});

describe('agentLlmKeyError', () => {
  it('needs OPENAI_API_KEY when the agents use OpenAI', () => {
    assert.equal(agentLlmKeyError({ OPENAI_API_KEY: 'sk' }), null);
    assert.equal(agentLlmKeyError({}), 'OPENAI_API_KEY is not set');
  });

  it('needs only AGENT_LLM_API_KEY when AGENT_LLM_BASE_URL is set', () => {
    assert.equal(agentLlmKeyError({ AGENT_LLM_BASE_URL: 'http://minipc.local:8080/v1', AGENT_LLM_API_KEY: 'local' }), null);
    assert.equal(
      agentLlmKeyError({ AGENT_LLM_BASE_URL: 'http://minipc.local:8080/v1', OPENAI_API_KEY: 'sk' }),
      'AGENT_LLM_API_KEY is not set',
    );
  });
});
