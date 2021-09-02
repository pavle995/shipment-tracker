// tslint:disable:ordered-imports
import express, { Express } from 'express'
import { createServer, Server } from 'http'
import passport from 'passport'
import request, { SuperTest, Test } from 'supertest'
import '../sequelize'
import { authCookieName, cookieAuthStrategy } from '../authenticateRequest'
import getProfile from '../routes/me'
import cookieParser from 'cookie-parser'
import { json } from 'body-parser'
import registerUser from '../routes/register'
import confirmRegistration from '../routes/register/confirm'
import login from '../routes/login'
import { renewCookie, deleteCookie } from '../routes/me/cookie'
import { v4 } from 'uuid'
import resetPassword from '../routes/me/password'
import sendVerificationTokenByEmail from '../routes/password/token'
import VerificationToken from '../models/verification_token'
import setNewPasswordUsingTokenAndEmail from '../routes/password/new'
import UserAccount from '../models/user_account'
import EventEmitter from 'events'
import { consoleMailer } from '../mailer/console'

jest.setTimeout(15 * 1000)

const cookieAuth = passport.authenticate('cookie', { session: false })
passport.use(cookieAuthStrategy)

const tokenCookieRx = new RegExp(`${authCookieName}=([^;]+);`, 'i')

const parseCookie = (cookie: string) =>
  cookie
    .split('; ')
    .map((s) => s.split('=', 2))
    .reduce(
      (c, [k, v], i) =>
        i === 0
          ? {
              [decodeURIComponent(k)]: v ? decodeURIComponent(v) : true,
            }
          : {
              ...c,
              options: {
                ...c.options,
                [decodeURIComponent(k)]: v ? decodeURIComponent(v) : true,
              },
            },
      {} as Record<string, any>,
    )

const email = `${v4()}@example.com`
const password = 'y{uugBmw"9,?=L_'
const omnibus = new EventEmitter()

describe('User account API', () => {
  let app: Express
  let httpServer: Server
  let r: SuperTest<Test>

  let authCookie: string
  beforeAll(async () => {
    app = express()
    app.use(cookieParser(process.env.COOKIE_SECRET ?? 'cookie-secret'))
    app.use(json())
    app.post('/register', registerUser(omnibus, 1))
    app.post('/register/confirm', confirmRegistration)
    app.post('/login', login)
    app.post('/password/token', sendVerificationTokenByEmail)
    app.post('/password/new', setNewPasswordUsingTokenAndEmail(1))
    app.get('/me', cookieAuth, getProfile)
    app.post('/me/password', cookieAuth, resetPassword(1))
    app.get('/me/cookie', cookieAuth, renewCookie)
    app.delete('/me/cookie', cookieAuth, deleteCookie)
    httpServer = createServer(app)
    await new Promise<void>((resolve) =>
      httpServer.listen(8888, '127.0.0.1', undefined, resolve),
    )
    r = request('http://127.0.0.1:8888')
  })
  afterAll(async () => {
    httpServer.close()
  })
  describe('/register', () => {
    it('should register a new user account', async () => {
      const res = await r
        .post('/register')
        .set('Content-type', 'application/json; charset=utf-8')
        .send({
          email,
          password,
          name: 'Alex',
        })
        .expect(202)
    })
    it.each([
      [email],
      [
        email.toUpperCase(), // emails are case-insensitive
      ],
    ])('should not allow to register with the same email (%s) twice', (email) =>
      r
        .post('/register')
        .set('Content-type', 'application/json; charset=utf-8')
        .send({
          email,
          password: 'R";%A:6mUVRst[Qq',
          name: 'Alex 2',
        })
        .expect(409),
    )
    describe('/register/confirm', () => {
      test('new accounts should not be able to log in', () =>
        r
          .post('/login')
          .send({
            email,
            password,
          })
          .expect(403))
      it('should confirm a user account with a token and an email', async () => {
        // Get token for email
        const token = await VerificationToken.findOne({
          where: {
            userAccountId: (await UserAccount.findOneByEmail(email))?.id,
          },
        })
        expect(token).not.toBeUndefined()
        return r
          .post('/register/confirm')
          .set('Content-type', 'application/json; charset=utf-8')
          .send({
            email,
            token: token?.token,
          })
          .expect(202)
      })
    })
  })
  describe('/login', () => {
    it('should return a token on login', async () => {
      const res = await r
        .post('/login')
        .send({
          email,
          password,
        })
        .expect(204)
        .expect('set-cookie', tokenCookieRx)

      const cookieInfo = parseCookie(res.header['set-cookie'][0] as string)
      expect(cookieInfo[authCookieName]).toBeDefined()
      expect(cookieInfo.options).toMatchObject({ Path: '/', HttpOnly: true })
      const expiresIn =
        new Date(cookieInfo.options.Expires).getTime() - Date.now()
      expect(expiresIn).toBeLessThan(30 * 60 * 1000)
      expect(expiresIn).toBeGreaterThan(0)

      authCookie = tokenCookieRx.exec(res.header['set-cookie'])?.[1] as string
    })
    it('should fail with invalid password', () =>
      r
        .post('/login')
        .send({
          email,
          password: "Y<N-'#sQ2/RCrN_c",
        })
        .expect(401))
    it('should fail with user not found', () =>
      r
        .post('/login')
        .send({
          email: 'foo@example.com',
          password: "Y<N-'#sQ2/RCrN_c",
        })
        .expect(401))
  })
  describe('/me', () => {
    it('should return the user account of the current user', async () => {
      const res = await r
        .get('/me')
        .set('Cookie', [`${authCookieName}=${authCookie}`])
        .set('Accept', 'application/json')
        .send()
        .expect(200)
      expect(res.body).toMatchObject({
        id: /[0-9]+/,
        email,
        isAdmin: false,
      })
    })
    it('should deny request for unknown token', async () =>
      r
        .get('/me')
        .set('Cookie', [`${authCookieName}=foo`])
        .send()
        .expect(401))
    describe('/me/cookie', () => {
      it('should send a new cookie', () =>
        r
          .get('/me/cookie')
          .set('Cookie', [`${authCookieName}=${authCookie}`])
          .expect(204))
      it('should delete a cookie', async () => {
        const res = await r
          .delete('/me/cookie')
          .set('Cookie', [`${authCookieName}=${authCookie}`])
          .expect(204)
        const cookieInfo = parseCookie(res.header['set-cookie'][0] as string)
        expect(cookieInfo[authCookieName]).toBeDefined()
        expect(cookieInfo.options).toMatchObject({ Path: '/', HttpOnly: true })
        const expiresIn =
          new Date(cookieInfo.options.Expires).getTime() - Date.now()
        expect(expiresIn).toBeLessThan(0) // Expires is in the past
      })
    })
    describe('/me/password', () => {
      const newPassword = 'H`2h?)Z<F-Z.3gYT'
      describe('as a logged-in user', () => {
        it('should change a users password if they know the current password', () =>
          r
            .post('/me/password')
            .set('Content-type', 'application/json; charset=utf-8')
            .set('Cookie', [`${authCookieName}=${authCookie}`])
            .send({
              currentPassword: password,
              newPassword,
            })
            .expect(204)
            .expect('set-cookie', tokenCookieRx))
        test('log-in with new password', () =>
          r
            .post('/login')
            .send({
              email,
              password: newPassword,
            })
            .expect(204))
        it('should not change a users password if they do not know the current password', () =>
          r
            .post('/me/password')
            .set('Content-type', 'application/json; charset=utf-8')
            .set('Cookie', [`${authCookieName}=${authCookie}`])
            .send({
              currentPassword: `some password`,
              newPassword: 'H`2h?)Z<F-Z.3gYT',
            })
            .expect(400))
      })
      describe('using an email token', () => {
        let token: string
        const newPasswordWithToken = "8>5_TZ?'hH9xd}Z7:"
        it('should create a password reset token', async () => {
          await r
            .post('/password/token')
            .set('Content-type', 'application/json; charset=utf-8')
            .send({
              email,
            })
            .expect(202)

          // Get token for email
          const t = await VerificationToken.findOne({
            where: {
              userAccountId: (await UserAccount.findOneByEmail(email))?.id,
            },
          })
          expect(t).not.toBeUndefined()
          token = t!.token
        })
        it('should reset the password using the token', () =>
          r
            .post('/password/new')
            .set('Content-type', 'application/json; charset=utf-8')
            .send({
              email,
              newPassword: newPasswordWithToken,
              token,
            })
            .expect(202))
        it('should not change a users password if they do not know the current password', async () => {
          expect(token).not.toEqual('000000') // Could fail sometimes, we use this as a test case here
          return r
            .post('/password/new')
            .set('Content-type', 'application/json; charset=utf-8')
            .send({
              email,
              newPassword: newPasswordWithToken,
              token: '000000',
            })
            .expect(401)
        })

        test('log-in with new password', () =>
          r
            .post('/login')
            .send({
              email,
              password: newPasswordWithToken,
            })
            .expect(204))
      })
    })
  })
})
