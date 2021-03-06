'use strict';

const AWS = require('aws-sdk');
const http = require('http');
const crypto = require('crypto');
const { promisify } = require('util');
const s3Client = new AWS.S3();

const s3Upload = promisify(s3Client.putObject.bind(s3Client));
const s3Get = promisify(s3Client.getObject.bind(s3Client));

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Allow-Methods': '*'
};

const mock = {
  area: [
    {"lat":53.92393936111111,"lng":27.693696},
    // {
    //   "lat": 51.520173035107824,
    //   "lng": -0.08995056152343751
    // },
    // {
    //   "lat": 51.520173035107824,
    //   "lng": -0.09012222290039064
    // }
  ]
};

const s3FieldParams = (fieldId, body) => ({
  Bucket: 'epam-jam1',
  Key: `fields/${fieldId}/meta.json`,
  ACL: 'public-read',
  Body: JSON.stringify(body),
  ContentType: 'application/json',
});

function rad2degr(rad) { return rad * 180 / Math.PI; }
function degr2rad(degr) { return degr * Math.PI / 180; }

function getCenters(coords) {
  let sumX = 0;
  let sumY = 0;
  let sumZ = 0;
  for (let i = 0; i< coords.length; i++) {
    let lat = degr2rad(coords[i]['lat']);
    let lng = degr2rad(coords[i]['lng']);
    sumX += Math.cos(lat) * Math.cos(lng);
    sumY += Math.cos(lat) * Math.sin(lng);
    sumZ += Math.sin(lat);
  }

  let avgX = sumX / coords.length;
  let avgY = sumY / coords.length;
  let avgZ = sumZ / coords.length;

  let lng = Math.atan2(avgY, avgX);
  let hyp = Math.sqrt(avgX * avgX + avgY * avgY);
  let lat = Math.atan2(avgZ, hyp);

  return { lat: rad2degr(lat), lng: rad2degr(lng) };
};

async function allBucketKeys(s3, bucket) {
  const params = {
    Bucket: bucket,
  };

  var keys = [];
  for (;;) {
    var data = await s3.listObjects(params).promise();

    data.Contents.forEach((elem) => {
      keys = keys.concat(elem.Key);
    });

    if (!data.IsTruncated) {
      break;
    }
    params.Marker = data.NextMarker;
  }

  return keys;
};

const httpPost = (host, port, path, data) => {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: host,
      port: port,
      path: path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      }
    }, function (res) {
      const chunks = [];
      res.on('data', function(d) { chunks.push(d); });
      res.on('error', function(e) {
        reject(e);
      })
      res.on('end', function () {
        const contentType = res.headers && res.headers['content-type'];
        
        console.log(contentType);

        if (contentType.search('json') !== -1) {
          const d = Buffer.concat(chunks);
          resolve(JSON.parse(d.toString()))
        } else {
          const d = Buffer.concat(chunks);
          resolve(d.toString('base64'))
        }
      });
    });
    req.write(JSON.stringify(data));
    req.end();
  })
}

module.exports.match = async (event) => {
  try {
    const data = event.Records[0].s3;
    const bucketName = data.bucket.name;
    const objectName = data.object.key;

    console.log(bucketName);
    console.log(objectName);

    const fieldCoordsParams = {
      Bucket: bucketName, 
      Key: objectName,
    };

    const { Body } = await s3Get(fieldCoordsParams);

    const fieldCoords = JSON.parse(Body);

    console.log(fieldCoords);

    const centers = getCenters(fieldCoords.coords);

    console.log(centers);

    const fileList = await allBucketKeys(s3Client, 'epam-jam1');

    const images = fileList.filter(file => file.search('images') !== -1 && file.search('.json') !== -1)
    
    const coordsData = await Promise.all(images.map(img => s3Get({ Bucket: bucketName,  Key: img })));

    const imagesAndCoords = coordsData.map((img, i) => ({
      coords: JSON.parse(img.Body.toString()),
      name: images[i]
    }));

    const isMatch = (coords, centers) => {
      return Math.abs(centers.lat - coords.lat) + Math.abs(centers.lng - coords.lng) < 0.01
    }

    const isMatchRemote = async (photos, shapes) => {
      const res = await httpPost(
        '34.201.39.171',
        5000,
        '/api/v1.0/match_photos_with_field',
        {shapes, photos}
      );

      return res;
      // return Math.abs(centers.lat - coords.lat) + Math.abs(centers.lng - coords.lng) < 0.01
    }
    
    // const matchedCoords = imagesAndCoords.find(s => isMatch(s.coords, centers));

    // console.log(matchedCoords);
    
    const imgCoors = imagesAndCoords.map(d => d.coords);

    const predCoords = await isMatchRemote(imgCoors, fieldCoords.coords);
    
    const predictionImages = imagesAndCoords.filter((im, i) => predCoords[i]);

    console.log(predictionImages);

    if (!predictionImages) {
        const prediction = {
          "id": objectName.replace('fields/', '').replace('/meta.json', ''),
          "name": fieldCoords.name,
          "fieldShape": fieldCoords.coords,
        }

        await s3Upload({
          Bucket: 'epam-jam1',
          Key: objectName.replace('meta', 'prediction'),
          ACL: 'public-read',
          Body: JSON.stringify(prediction),
          ContentType: 'application/json',
        });
    
        return {
          statusCode: 200,
        };
    }

    const imageUrls = predictionImages.map(p => `https://s3.amazonaws.com/${bucketName}/${p.name}`.replace('.json', '.JPG'));

    // http://34.201.39.171:5000/api/v1.0/process_image_from_url?task_name=detect_artifacts&with_original'

    async function readImages(files) {
      const photos = [];
      for(const imageUrl of imageUrls) {
        const ph = await httpPost(
          '34.201.39.171',
          5000,
          '/api/v1.0/get_image_metadata_from_url?task_name=detect_artifacts',
          {url: imageUrl}
        );
  
        const mask = await httpPost(
          '34.201.39.171',
          5000,
          '/api/v1.0/process_image_from_url?task_name=detect_artifacts',
          {url: imageUrl}
        );

        if (typeof ph !== 'string')  {
          ph.id = crypto.randomBytes(16).toString("hex");
          ph.src = imageUrl;
          ph.dmz = 1 - ph.class_percentages.field - ph.class_percentages.road;
          ph.mask = mask;

          photos.push(ph);
        }
      }
      return photos;
    };

    const photos = await readImages(imageUrls);

    const spZ = photos.reduce((acc, ph) => acc += ph.dmz, 0);

    // call recognize api
    const prediction = {
      "id": objectName.replace('fields/', '').replace('/meta.json', ''),
      "name": fieldCoords.name,
      "fieldShape": fieldCoords.coords,
      "suspiciousZone": spZ / photos.length,
      "photos": photos
    };

    console.log(prediction);

    await s3Upload({
      Bucket: 'epam-jam1',
      Key: objectName.replace('meta', 'prediction'),
      ACL: 'public-read',
      Body: JSON.stringify(prediction),
      ContentType: 'application/json',
    });

    return {
      statusCode: 200,
    };
  } catch (e) {
    console.log(e);
    return {
      statusCode: 500,
    };
  }
};

module.exports.fieldCreate = async (event) => {
  console.log(event.body);

  try {
    const data = JSON.parse(event.body || '{}');

    if (!data.name) {
      throw new Error('missed keys name and fieldShape');
    }

    if (!Array.isArray(data.fieldShape)) {
      throw new Error('missed keys name and fieldShape');
    }

    const id = crypto.randomBytes(16).toString("hex");
    await s3Upload(
      s3FieldParams(id, { name: data.name, coords: data.fieldShape })
    );

    return {
      statusCode: 200,
      headers: { ...CORS },
      body: JSON.stringify({
        status: 'OK',
        data: {
          fieldId: id,
        }
      }),
    };
  } catch (e) {
    console.log(e);
    return {
      statusCode: 500,
      headers: { ...CORS },
      body: JSON.stringify({
        status: 'ERROR',
        data: {
          error: e.message || ''
        }
      }),
    };
  }
};

module.exports.fieldDetails = async (event) => {
  console.log(event);
  try {
    const { id } = event.pathParameters;

    const fileList = await allBucketKeys(s3Client, 'epam-jam1');

    const fieldKey = fileList.find(file => file.search('fields') !== -1 && file.search(`${id}`) !== -1 && file.search('prediction.json') !== -1)
    
    console.log(fieldKey);

    if (fieldKey === undefined) {
      const metaKey = fileList.find(file => file.search('fields') !== -1 && file.search(`${id}`) !== -1 && file.search('meta.json') !== -1)
      
      console.log(metaKey);

      if (!metaKey) {
        throw new Error('I cant find field');
      }
      
      const metaData = await s3Get({ Bucket: 'epam-jam1',  Key: metaKey });
      
      const meta = JSON.parse(metaData.Body.toString());

      return {
        statusCode: 200,
        headers: { ...CORS },
        body: JSON.stringify({
          status: 'OK',
          data: { name: meta.name, id, fieldShape: meta.coords }
        })
      };
    }

    const data = await s3Get({ Bucket: 'epam-jam1',  Key: fieldKey });

    return {
      statusCode: 200,
      headers: { ...CORS },
      body: JSON.stringify({
        status: 'OK',
        data: JSON.parse(data.Body.toString())
      })
    };
  } catch (e) {
    console.log(e);
    return {
      statusCode: 500,
      headers: { ...CORS },
      body: JSON.stringify({
        status: 'ERROR',
        data: {
          error: e.message || ''
        }
      }),
    };
  }
};

module.exports.fields = async (event) => {
  try {
    const data = JSON.parse(event.body || '{}');
    const fileList = await allBucketKeys(s3Client, 'epam-jam1');
    const predictions = fileList.filter(file => file.search('field') !== -1 && file.search('prediction.json') !== -1)
    const images = await Promise.all(predictions.map(img => s3Get({ Bucket: 'epam-jam1',  Key: img })));
     
    return {
      statusCode: 200,
      headers: { ...CORS },
      body: JSON.stringify({
        status: 'OK',
        data: images.map(img => JSON.parse(img.Body.toString())).map(v => ({
          id: v.id,
          name: v.name,
          src: v.photos ? v.photos[0] ? v.photos[0].src : null : null
        }))
      }),
    };

  } catch (e) {
    console.log(e);
    return {
      statusCode: 500,
      headers: { ...CORS },
      body: JSON.stringify({
        status: 'ERROR',
        data: {
          error: e.message || ''
        }
      }),
    };

  }
};