//-----------------------------------
// Copyright(c) 2015 猫王子
//-----------------------------------

'use strict'

import * as net from 'net';
import { EventEmitter } from 'events';
import * as crypto from 'crypto';
import * as cryptoEx from '../lib/cipher';
import { VPN_TYPE, Socks5Options } from '../lib/constant'
import { handleSocks5 } from './socks5/index';
import { handleOSXSocks5 } from './osxcl5/index';

export type ServerOptions = {
  cipherAlgorithm: string,
  password: string,
  port: number,
  timeout?: number,
  expireTime?: number,
  disableSelfProtection?: boolean
}

export class LsServer extends EventEmitter {
  cipherAlgorithm: string;
  password: string;
  port: number;
  timeout: number;
  disableSelfProtection = false;
  expireTime: number; // Unit: ms
  
  private expireTimer: NodeJS.Timer;
  private blacklistIntervalTimer: NodeJS.Timer;
  private blacklist = new Map<string, Set<number>>();
  private server: net.Server;
  private requestHandlers = new Map<VPN_TYPE, (client: net.Socket, data: Buffer, options: Socks5Options) => boolean>();
  
  constructor(options: ServerOptions) {
    super()
    
    let me = this;
    Object.getOwnPropertyNames(options).forEach(n => me[n] = options[n]);
    
    this.requestHandlers.set(VPN_TYPE.SOCKS5, handleSocks5);
    this.requestHandlers.set(VPN_TYPE.OSXCL5, handleOSXSocks5);
  }
  
  start() {
    let me = this;
    
    let server = net.createServer(async (client) => {
      if (me.blacklist.has(client.remoteAddress) && me.blacklist.get(client.remoteAddress).size > 20) return client.dispose();
      
      let data = await client.readAsync();
      if (!data) return client.dispose();
      
      let meta = cryptoEx.SupportedCiphers[me.cipherAlgorithm];
      let ivLength = meta[1];
      
      if (data.length < ivLength) {
        console.warn(client.remoteAddress, 'Malicious Access');
        return me.addToBlacklist(client);
      }
      
      let iv = data.slice(0, ivLength);
      let decipher = cryptoEx.createDecipher(me.cipherAlgorithm, me.password, iv);
      
      let et = data.slice(ivLength, data.length);
      let dt = decipher.update(et);
      
      if (dt.length < 2) {
        console.warn(client.remoteAddress, 'Malicious Access')
        return me.addToBlacklist(client);
      }
      
      let vpnType = dt[0];
      let paddingSize = dt[1];
      
      let options = {
        decipher,
        password: me.password,
        cipherAlgorithm: me.cipherAlgorithm,
        timeout: me.timeout,
        xorNum: paddingSize
      };
      
      let request = dt.slice(2 + paddingSize, data.length);
      
      let handler = me.requestHandlers.get(vpnType);
      if (!handler) return me.addToBlacklist(client);
      
      let handled = handler(client, request, options);
      
      if (handled) return;
      me.addToBlacklist(client);
    });
    
    this.server = server;
    server.listen(this.port);
    server.on('error', (err) => { 
      console.error(err.message);
      me.stop();
    });
    
    this.blacklistIntervalTimer = setInterval(() => me.blacklist.clear(), 10 * 60 * 1000);
    this.blacklistIntervalTimer.unref();
    this.startExpireTimer();
  }
  
  stop() {
    this.server.end();
    this.server.close();  
    this.server.destroy();
    this.stopExpireTimer();
    this.emit('close');
    this.blacklist.clear();
    
    if (this.blacklistIntervalTimer) clearInterval(this.blacklistIntervalTimer);
    this.blacklistIntervalTimer = undefined;
  }

  private addToBlacklist(client: net.Socket) {
    if (this.disableSelfProtection) return;
    
    let ports = this.blacklist.get(client.remoteAddress);
    if (!ports) {
      ports = new Set<number>();
      this.blacklist.set(client.remoteAddress, ports);
    }
    
    ports.add(client.remotePort);
    client.dispose();
  }
  
  private startExpireTimer() {
    if (!this.expireTime) return;
    this.stopExpireTimer();
    
    let me = this;
    this.expireTimer = setTimeout(() => me.stop(), me.expireTime);
    this.expireTimer.unref();
  }
  
  private stopExpireTimer() {
    if (!this.expireTimer) return;
    
    clearTimeout(this.expireTimer);
    this.expireTimer = null;
  }
}