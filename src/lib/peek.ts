import { createContext } from "react";

/**
 * True inside the copy of the previous page drawn under one being swiped back (see BackPeek in App.tsx). That copy
 * only shows: it mustn't announce itself to the app the way the page really on screen does (the top bar's header).
 */
export const PeekContext = createContext(false);
