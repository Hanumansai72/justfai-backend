const special = new Set('.*+?^${}()|[]\\');
module.exports = value => Array.from(String(value), char => special.has(char) ? '\\' + char : char).join('');
