"use strict"

function valuesAsList(enumeration){
  let out = [];
  for (let k in enumeration) {
    out.push(enumeration[k]);
  }
  return out;
}

function chooseRandom(list) {
  return list[Math.floor(Math.random() * list.length)];
}
