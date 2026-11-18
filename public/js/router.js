// Lets a page send the user to another page with some context (for example "block this command" from the request details).
let go = () => {};
export const onNavigate = (fn) => { go = fn; };
export const navigate = (id, payload) => go(id, payload);
