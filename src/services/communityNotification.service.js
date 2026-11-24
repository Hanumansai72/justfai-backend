const User = require('../models/User');
const { sendNotification } = require('../controllers/notification.controller');

const preferenceByType = {
  RIDE_INVITATION: 'rideInvitations',
  RIDE_JOIN_REQUEST: 'rideRequests',
  RIDE_JOIN_ACCEPTED: 'rideRequests',
  ASSISTANCE_REQUEST: 'assistanceNearby',
  ASSISTANCE_OFFER: 'assistanceOffers',
  ASSISTANCE_ACCEPTED: 'assistanceOffers',
};

async function sendCommunityNotification(payload) {
  const preference = preferenceByType[payload.type];
  if (preference) {
    const user = payload._user || await User.findById(payload.user_id).select('communityNotifications').lean();
    if (!user || user.communityNotifications?.[preference] === false) return null;
  }
  const { _user, ...notification } = payload;
  return sendNotification(notification);
}

module.exports = { sendCommunityNotification };
