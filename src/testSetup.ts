import { configure } from "@testing-library/react";

// How long a findBy or waitFor waits for the page to settle. Testing Library's one second is
// shorter than a full render of Home takes on a loaded CI runner, and the suite was paying for it
// in tests that failed only when the machine was busy (and in a dozen local `{ timeout: 5000 }`s).
// A test that passes never waits for this; only one that is going to fail waits it out. The ui
// project's testTimeout (vite.config.ts) is raised to match: a test that walks every page of a look
// waits on several of these in turn.
configure({ asyncUtilTimeout: 5000 });
