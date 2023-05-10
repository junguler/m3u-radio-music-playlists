#!/bin/bash

# get genres, countires and languages streams 
curl https://online-radio.eu/ | htmlq -a href a | grep "genre" | sort | uniq | cut -c31- | awk 'NR>1' > genres.txt
curl https://online-radio.eu/ | htmlq -a href a | grep "country" | sort | uniq | cut -c33- | awk 'NR>1' > countries.txt
curl https://online-radio.eu/language | htmlq -a href a | grep "language" | sort | uniq | cut -c34- | awk 'NR>1' > languages.txt

# find stream pages 
curl https://online-radio.eu/top100 | htmlq -a href a | grep "/radio/" | cut -c31- > A-top_100.txt
for i in "" \?page={2..200} ; do for j in $(cat genres.txt) ; do curl -s https://online-radio.eu/genre/$j$i | htmlq -a href a | grep "/radio/" | cut -c31- >> A-$j.txt ; echo -e "$j - $i" ; done ; done
for i in "" \?page={2..160} ; do for j in $(cat countries.txt) ; do curl -s https://online-radio.eu/country/$j$i | htmlq -a href a | grep "/radio/" | cut -c31- >> A-$j.txt ; echo -e "$j - $i" ; done ; done
for i in "" \?page={2..150} ; do for j in $(cat languages.txt) ; do curl -s https://online-radio.eu/language/$j$i | htmlq -a href a | grep "/radio/" | cut -c31- >> A-$j.txt ; echo -e "$j - $i" ; done ; done

# remove duplicate links 
for i in A-*.txt ; do cat $i | awk '!seen[$0]++' > A$i ; echo -e $i ; done

# scrape the streams
#for i in AA-*.txt ; do for j in $(cat $i) ; do curl -s https://online-radio.eu/radio/$j | grep "url\":" | head -n 1 | awk -F '"' '{print $4}' | grep -v "object" | sed 's/\;//g' | sed '/^$/d' >> A$i ; echo -e "$i - $j" ; done ; done
for i in AA-*.txt ; do for j in $(cat $i) ; do curl -s https://online-radio.eu/export/winamp/$j | grep "Title\|File" | sed 's/File1\=//g' | sed 's/Title1\=/#EXTINF:-1 , /g' | sed 's/\;//g' >> A$i ; echo -e "$j - $i" ; done ; done

# convert links to m3u streams
for i in AAA-*.txt ; do sed '1s/^/#EXTM3U\n/' $i > $i.m3u ; done

# remove AAA- and double extensions in streams
for i in *.m3u ; do mv "$i" "`echo $i | sed -e 's/AAA-//' -e 's/.txt//'`" ; done

# replace %20 in file names with _
for i in *.m3u ; do mv -- "$i" "$(printf '%s\n' "$i" | sed 's/%20/_/')" ; done

# remove temp and empty files 
rm A-top_100.txt genres.txt countries.txt languages.txt
find . -type f -empty -delete
