export const APP_EVENTS = Object.freeze({
  openTrackingResults: 'twt:open-tracking-results'
});

export const createElement = (tagName, { className, text, attributes = {} } = {}) => {
  const element = document.createElement(tagName);

  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;

  Object.entries(attributes).forEach(([name, value]) => {
    element.setAttribute(name, value);
  });

  return element;
};
