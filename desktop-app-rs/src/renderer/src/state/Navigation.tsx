import { createContext, useContext } from 'react';

export interface NavigationApi {
    /** Switches to the Library tab; opens that video's detail page when the id is known. */
    openLibraryVideo: (id?: number) => void;
}

const NOOP: NavigationApi = { openLibraryVideo: () => undefined };

export const NavigationContext = createContext<NavigationApi>(NOOP);

export function useNavigation(): NavigationApi {
    return useContext(NavigationContext);
}
