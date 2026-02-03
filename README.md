# Location Sharing App

API-first location sharing app with username/password authentication, friend requests, and location visibility only between accepted friends.

## Features
- Register/login with username + password
- List all users (no locations exposed)
- Send/accept friend requests
- Update your location
- View friends' locations

## Setup
```bash
npm install
npm start
```

Set a custom JWT secret in production:
```bash
export JWT_SECRET="replace-me"
```

## API Endpoints
### Auth
- `POST /api/register` `{ "username": "alice", "password": "secret" }`
- `POST /api/login` `{ "username": "alice", "password": "secret" }`

### Users
- `GET /api/users` (auth required)

### Friend Requests
- `POST /api/friends/request` `{ "toUserId": 2 }`
- `GET /api/friends/requests`
- `POST /api/friends/accept` `{ "requestId": 1 }`

### Locations
- `POST /api/location` `{ "lat": 40.7128, "lng": -74.0060 }`
- `GET /api/friends`

All authenticated requests require:
```
Authorization: Bearer <token>
```
