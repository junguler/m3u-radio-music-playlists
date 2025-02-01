#!/bin/bash

# check the sitemap for all the sub pages
curl -s https://radio-tune.com/sitemap.xml | htmlq sitemap loc -t > sitemap.txt

# extract country links from the sitemap page
curl -s https://radio-tune.com/category-sitemap.xml | htmlq url loc -t | awk -F '/' '{print $5}' > countries.txt

# get the links to all the stream pages within the website
for i in $(cat sitemap.txt | grep 'post-sitemap') ; do curl -s $i | htmlq url loc -t | cut -c23- >> streams.txt ; echo $i ; done

# split all links by country
for i in $(cat countries.txt) ; do grep \/$i\/ streams.txt > A-$i.txt ; done

# scrape stream title, links and create a genres.txt from each page
for i in A-*.txt ; do for j in $(cat $i) ; do curl -s https://radio-tune.com$j > mep1 ; cat mep1 | htmlq -t h1 | awk 'NR==1 {$0="#EXTINF:-1," $0} 1' >> A$i ; cat mep1 | htmlq source | head -n 1 | awk -F '"' '{print $2}' | sed 's/\;//g' | sed '/^$/d' >> A$i ; cat mep1 | htmlq .post-meta2 -a href a | grep '/genres/' | awk -F '/' '{print $5}' | awk NF >> genre-dup.txt ; echo -e "$i - $j" ; done ; done

# remove duplicated genre links
cat genre-dup.txt | sort | uniq > genres.txt

# extract data from genre pages
for j in $(cat genres.txt) ; do curl -s https://radio-tune.com/genres/$j | htmlq .widget_categories2a -a href a | cut -c23- >> A-$j.txt ; echo $j ; done
for i in page{2..50}/ ; do for j in $(cat genres.txt) ; do curl -s https://radio-tune.com/genres/$j/$i | htmlq .widget_categories2a -a href a | cut -c23- >> A-$j.txt ; echo "$j - $i" ; done ; done

# rerun the scraping stream part for the genre files (line 16)

# remove streams that didn't have links
for i in AA-*.txt ; do cat $i | awk '!seen[$0]++' | grep -B1 "http" | grep -A1 "EXTINF" | awk 'length>4' > A$i ; echo -e $i ; done

# convert links to m3u streams
for i in AAA-*.txt ; do sed '1s/^/#EXTM3U\n/' $i > $i.m3u ; done

# remove AAA- and double extensions in streams
for i in *.m3u ; do mv "$i" "`echo $i | sed -e 's/AAA-//' -e 's/.txt//'`" ; done
