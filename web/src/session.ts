import { createContext, useContext } from 'react';
import type { Facets, User } from './api.ts';

export interface Session { user: User; facets: Facets | undefined; refreshFacets: () => void; setUser: (u: User | null) => void }
export const SessionCtx = createContext<Session>(null as unknown as Session);
export const useSession = () => useContext(SessionCtx);
