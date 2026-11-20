import { createContext, useContext } from 'react';

export type Tab = 'home' | 'queue' | 'library' | 'settings' | 'about';

export interface NavigationApi {
    /** Switches to the Library tab; opens that video's detail page when the id is known. */
    openLibraryVideo: (id?: number) => void;
    /** Switches to a tab and moves the focus to its tab button. */
    openTab: (tab: Tab) => void;
}

const NOOP: NavigationApi = { openLibraryVideo: () => undefined, openTab: () => undefined };

export const NavigationContext = createContext<NavigationApi>(NOOP);

export function useNavigation(): NavigationApi {
    return useContext(NavigationContext);
}
