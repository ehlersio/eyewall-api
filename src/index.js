import { app } from './app.js';

export default {
  fetch: (request, env, ctx) => app.fetch(request, env, ctx),
};
