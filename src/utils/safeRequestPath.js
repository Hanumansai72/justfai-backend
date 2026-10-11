module.exports = (req) => req.originalUrl.split('?')[0].replace(/(\/users\/reset-password\/)[^/]+/, '$1[redacted]');
