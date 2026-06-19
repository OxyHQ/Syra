import { QueryClient } from '@tanstack/react-query';
import { QUERY_CLIENT_CONFIG } from '@/components/providers/constants';

export const queryClient = new QueryClient(QUERY_CLIENT_CONFIG);
