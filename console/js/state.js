'use strict';
/* ---- shared state --------------------------------------------------------
   One mutable object, imported by every other module. ES module bindings are
   live, so `import { state } from './state.js'` in two different files sees
   the same object - there is exactly one copy, the same as when this was all
   one script and `state` was a top-level const.
--------------------------------------------------------------------------- */

export const state = {
  leads: [], counts: {}, total: 0,
  loading: true, error: null,
  q: '', tiers: new Set(), tab: 'all', presence: '',
  area: '', areas: {},
  sort: 'score', dir: -1,
  selected: null, draft: { loading: false, data: null },
  view: [],
};
