#!/usr/bin/env node

/**
 * This script gathers dates and payload names from the subreddit launch manifest,
 * fuzzy checks them against existing upcoming payload id's and updates the date if a
 * change is made in the wiki. The proper time zone is calculated from the launch site
 * id of the launch.
 */

const MongoClient = require('mongodb');
const moment = require('moment-timezone');
const cheerio = require('cheerio');
const request = require('request-promise-native');
const fuzz = require('fuzzball');

moment.suppressDeprecationWarnings = true;

let client;
let location;
let calculatedTimes;
let localTime;
let date;

const sites = [];
const payloads = [];
const promises = [];

(async () => {
  try {
    client = await MongoClient.connect(process.env.MONGO_URL, { useNewUrlParser: true });

    const db = client.db('spacex-api');
    const col = db.collection('launch');

    const launches = await col.find({ upcoming: true }).toArray();

    // Collect site names for time zone and payload name for fuzzy check
    launches.forEach(launch => {
      // Add temp fix for last Iridium NEXT launch because we need fuzzy
      // search to return 100% substring match, else we get SSO-A and SSO-B changing
      // because of a slight difference.
      // NOTE: Will be removed after launch
      if (launch.rocket.second_stage.payloads[0].payload_id === 'Iridium NEXT 8') {
        payloads.push('Iridium 8');
      } else {
        payloads.push(launch.rocket.second_stage.payloads[0].payload_id);
      }
      sites.push(launch.launch_site.site_id);
    });

    // Grab subreddit wiki manifest
    const result = await request('https://www.reddit.com/r/spacex/wiki/launches/manifest');
    const $ = cheerio.load(result);

    // Grab entire row, clean date, and convert to valid UTC moment date
    const manifest = $('body > div.content > div > div > table:nth-child(6) > tbody').text();
    const manifest_row = manifest.split('\n').filter(v => v !== '');

    // Filter to collect manaifest dates
    const manifest_dates = manifest_row.filter((value, index) => {
      return index % 8 === 0;
    });

    manifest_dates.forEach((elem, index) => {
      if (elem.includes('Q')) {
        manifest_dates[index] = manifest_dates[index].replace('Q', '');
      } else if (elem.includes('H1')) {
        manifest_dates[index] = manifest_dates[index].replace('H1', '1');
      } else if (elem.includes('H2')) {
        manifest_dates[index] = manifest_dates[index].replace('H2', '3');
      }
    });

    // Filter to collect payload names
    const manifest_payloads = manifest_row.filter((value, index) => {
      return (index + 3) % 8 === 0;
    });

    payloads.forEach((payload, p_index) => {
      manifest_payloads.forEach((manifest_payload, m_index) => {
        if (fuzz.partial_ratio(payload, manifest_payload) === 100) {
          location = sites[p_index];
          date = manifest_dates[m_index];

          console.log(date);
          console.log(`${payload} : ${manifest_payload}`);

          const stripped_time = `${date.replace('[', '').replace(']', '')} +0000`;
          const time = moment(stripped_time, ['YYYY MMM D HH:mm Z', 'YYYY MMM D Z', 'YYYY MMM Z', 'YYYY Q Z', 'YYYY Z']);
          const zone = moment.tz(time, 'UTC');

          // Set timezone based on launch location
          if (location === 'ccafs_slc_40' || location === 'ksc_lc_39a' || location === 'ccafs_lc_13') {
            localTime = time.tz('America/New_York').format();
          } else if (location === 'vafb_slc_4e' || location === 'vafb_slc_4w') {
            localTime = time.tz('America/Los_Angeles').format();
          } else {
            localTime = time.tz('America/Chicago').format();
          }

          // Build launch time objects to update
          calculatedTimes = {
            launch_date_unix: zone.unix(),
            launch_date_utc: zone.toISOString(),
            launch_date_local: localTime,
          };
          console.log(calculatedTimes);
          console.log('');

          // Another special case added for last Iridium launch
          // NOTE: Will be removed after launch
          if (payload === 'Iridium 8') {
            payload = 'Iridium NEXT 8';
          }

          promises.push(col.updateOne({ 'rocket.second_stage.payloads.payload_id': payload }, { $set: calculatedTimes }));
        }
      });
    });
    const output = await Promise.all(promises);
    output.forEach(doc => {
      console.log(`N: ${doc.result.n}`);
      console.log(`Modified: ${doc.result.nModified}`);
    });
  } catch (err) {
    console.log(err.stack);
  }

  if (client) {
    client.close();
  }
})();