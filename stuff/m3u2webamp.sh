#!/bin/bash

# convert m3u files to pretend json for webamp
for i in *.m3u ; do cat $i | jc --m3u | jq . | grep -v "tvg-logo\|group-title\|runtime" | sed -e 's/"path"/url/g' -e 's/"display"/metaData:{title/g' -e 's/",/"},/g' > A-$i.txt ; done

# prepare prefix and suffix so the for loop can used
# copy this line to a file named prefix.txt
# <!doctype html><meta charset=utf-8><div id=app style=height:100vh></div><script src=./webamp.bundle.min.js></script><script src=./butterchurn.min.js></script><script src=./butterchurnPresets.min.js></script><script>const Webamp=window.Webamp;new Webamp({initialTracks:

# copy this line to a file named suffix.txt
# ,__butterchurnOptions:{importButterchurn:()=>Promise.resolve(window.butterchurn),getPresets:()=>{const e=window.butterchurnPresets.getPresets();return Object.keys(e).map(t=>({name:t,butterchurnPresetObject:e[t]}))},butterchurnOpen:!0},__initialWindowLayout:{main:{position:{x:0,y:0}},equalizer:{position:{x:0,y:116}},playlist:{position:{x:0,y:232},size:[0,4]},milkdrop:{position:{x:275,y:0},size:[7,12]}}}).renderWhenReady(document.getElementById("app"))</script>

# could not find a way to echo these lines without issues

# look here for refrence
# https://github.com/captbaritone/webamp/blob/master/examples/minimalMilkdrop/index.html

# create html files
for i in A-*.txt ; do cat prefix.txt $i suffix.txt > $i.html ; done

# remove A- and triple extensions in the html files
for i in *.html ; do mv "$i" "`echo $i | sed -e 's/A-//' -e 's/.m3u.txt//'`" ; done

# optional: minify html files
for i in *.html ; do minify -o out/$i $i ; done
