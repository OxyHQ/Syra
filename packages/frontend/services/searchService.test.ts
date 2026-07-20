import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { api } from '@/utils/api';
import { searchService } from './searchService';

jest.mock('@/utils/api', () => ({
  api: {
    get: jest.fn(),
  },
}));

const mockApiGet = api.get as jest.MockedFunction<typeof api.get>;

describe('searchService validation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('rejects malformed search responses at the API boundary', async () => {
    mockApiGet.mockResolvedValueOnce({ data: { query: 'jazz' } });

    await expect(searchService.search('jazz')).rejects.toThrow('Invalid search response');
  });
});
